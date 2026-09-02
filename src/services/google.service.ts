// src/services/google.service.ts

import { eq, and } from "drizzle-orm";
import { resolveUniqueUsername } from "../utils/username";
import { fail } from "../utils/error";
import type { AnyAuthDB } from "../types/index";
import { AuthDbAdapter, createAuthDbAdapter, type AuthDbDialect } from "../db/adapter";
import type { AuthService } from "./auth.service";
import type { IImageFilterService } from "../utils/image-filter";
import type { ClientType } from "../config/token.config";

export interface GoogleUserInfo {
  sub: string; // Google user ID (unique, permanent)
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
}

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
  id_token?: string;
}

interface GoogleTokenInfoResponse {
  sub: string;
  email: string;
  email_verified: string; // "true" / "false"
  name?: string;
  picture?: string;
  exp: string;
  aud: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class GoogleOAuthService {
  private readonly adapter: AuthDbAdapter;

  constructor(
    dbOrAdapter: AnyAuthDB | AuthDbAdapter,
    private readonly authService: AuthService,
    private readonly imageFilter: IImageFilterService,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly bucketPublicUrl?: string,
    private readonly allowedClientIds?: string,
    dialect: AuthDbDialect = "pg",
  ) {
    if ("dialect" in dbOrAdapter && "tables" in dbOrAdapter) {
      this.adapter = dbOrAdapter;
    } else {
      this.adapter = createAuthDbAdapter(dbOrAdapter, dialect);
    }
  }

  get db(): any {
    return this.adapter.db;
  }

  // ── Web Flow: Generate Authorization URL ─────────────────────────────────

  getAuthorizationUrl(
    state: string,
    redirectUri: string,
    codeChallenge?: string,
    codeChallengeMethod: string = "S256",
  ): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      access_type: "offline",
      prompt: "consent",
    });

    if (codeChallenge) {
      params.set("code_challenge", codeChallenge);
      params.set("code_challenge_method", codeChallengeMethod);
    }

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  // ── Web Flow: Exchange Authorization Code → Access Token ─────────────────

  async exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string,
  ): Promise<GoogleTokenResponse> {
    const bodyParams = new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });

    if (codeVerifier) {
      bodyParams.set("code_verifier", codeVerifier);
    }

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: bodyParams,
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("[google] Token exchange failed:", error);
      fail("Gagal menukar authorization code", "GOOGLE_TOKEN_EXCHANGE_FAILED");
    }

    return response.json() as Promise<GoogleTokenResponse>;
  }

  // ── Web Flow: Get User Info dari Access Token ────────────────────────────

  async getUserInfo(accessToken: string): Promise<GoogleUserInfo> {
    const response = await fetch(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!response.ok) {
      console.error("[google] Userinfo failed:", await response.text());
      fail("Gagal mengambil profil Google", "GOOGLE_USERINFO_FAILED");
    }

    return response.json() as Promise<GoogleUserInfo>;
  }

  // ── Mobile Flow: Verify ID Token ─────────────────────────────────────────

  async verifyIdToken(idToken: string): Promise<GoogleUserInfo> {
    const response = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
    );

    if (!response.ok) {
      console.error(
        "[google] ID token verification failed:",
        await response.text(),
      );
      fail("ID Token Google tidak valid", "GOOGLE_ID_TOKEN_INVALID");
    }

    const data = (await response.json()) as GoogleTokenInfoResponse;

    const allowed = (this.allowedClientIds ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const validAudience = data.aud === this.clientId || allowed.includes(data.aud);

    if (!validAudience) {
      fail("ID Token audience tidak sesuai", "GOOGLE_ID_TOKEN_INVALID_AUD");
    }

    if (data.exp && Date.now() / 1000 > parseInt(data.exp, 10)) {
      fail("ID Token sudah expired", "GOOGLE_ID_TOKEN_EXPIRED");
    }

    return {
      sub: data.sub,
      email: data.email,
      email_verified: data.email_verified === "true",
      name: data.name,
      picture: data.picture,
    };
  }

  // ── Account Linking Logic ────────────────────────────────────────────────

  async handleGoogleLogin(
    googleUser: GoogleUserInfo,
    clientType: ClientType,
    deviceInfo?: Record<string, string>,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    isNewUser: boolean;
    linked: boolean;
  }> {
    if (!googleUser.email_verified) {
      fail(
        "Email Google belum terverifikasi",
        "GOOGLE_EMAIL_NOT_VERIFIED",
        400,
      );
    }

    const email = googleUser.email.toLowerCase().trim();
    const oauthAccountsTable = this.adapter.tables.oauthAccounts;
    const usersTable = this.adapter.tables.users;

    // 1. Cek apakah sudah ada oauth_account untuk Google sub ini (dengan single query JOIN ke users)
    const [existing] = await this.db
      .select({
        oauth: oauthAccountsTable,
        user: usersTable,
      })
      .from(oauthAccountsTable)
      .innerJoin(usersTable, eq(usersTable.id, oauthAccountsTable.userId))
      .where(
        and(
          eq(oauthAccountsTable.provider, "google"),
          eq(oauthAccountsTable.providerUserId, googleUser.sub),
        ),
      )
      .limit(1);

    if (existing) {
      const { oauth: existingOAuth, user: existUser } = existing;

      if (!existUser || !existUser.isActive || existUser.deletedAt) {
        fail("Akun telah dinonaktifkan", "ACCOUNT_DISABLED", 403);
      }

      const filteredAvatar = await this.imageFilter.filterImageUrl(
        googleUser.picture,
      );

      await this.db
        .update(oauthAccountsTable)
        .set({
          email,
          displayName: googleUser.name ?? null,
          avatarUrl: filteredAvatar,
          updatedAt: new Date(),
        })
        .where(eq(oauthAccountsTable.id, existingOAuth.id));

      const userUpdates: Record<string, any> = {
        updatedAt: new Date(),
      };
      if (!existUser.username) {
        userUpdates.username = await this.resolveUniqueUsername(
          email.split("@")[0],
        );
      }
      if (!existUser.fullName && googleUser.name) {
        userUpdates.fullName = googleUser.name;
      }
      if (Object.keys(userUpdates).length > 1) {
        await this.db
          .update(usersTable)
          .set(userUpdates)
          .where(eq(usersTable.id, existingOAuth.userId));
      }

      const tokens = await this.authService.generateTokenPair(
        existingOAuth.userId,
        clientType,
        undefined,
        deviceInfo,
      );

      return { ...tokens, isNewUser: false, linked: false };
    }

    // 2. Tidak ada oauth_account → cek apakah ada user dengan email yang sama
    const existingUser = await this.db.query.users.findFirst({
      where: eq(usersTable.email, email),
    });

    if (existingUser) {
      if (!existingUser.isActive || existingUser.deletedAt) {
        fail("Akun telah dinonaktifkan", "ACCOUNT_DISABLED", 403);
      }

      const filteredAvatar = await this.imageFilter.filterImageUrl(
        googleUser.picture,
      );

      let resolvedUsername: string | undefined;
      if (!existingUser.username) {
        resolvedUsername = await this.resolveUniqueUsername(
          email.split("@")[0],
        );
      }

      await this.db.transaction(async (tx: any) => {
        await tx.insert(oauthAccountsTable).values({
          userId: existingUser.id,
          provider: "google",
          providerUserId: googleUser.sub,
          email,
          displayName: googleUser.name ?? null,
          avatarUrl: filteredAvatar,
        });

        const linkUpdates: Record<string, any> = {
          isEmailVerified: true,
          fullName: googleUser.name ?? existingUser.fullName ?? null,
          avatarUrl: existingUser.avatarUrl,
          updatedAt: new Date(),
        };
        if (resolvedUsername) {
          linkUpdates.username = resolvedUsername;
        }

        await tx
          .update(usersTable)
          .set(linkUpdates)
          .where(eq(usersTable.id, existingUser.id));
      });

      const tokens = await this.authService.generateTokenPair(
        existingUser.id,
        clientType,
        undefined,
        deviceInfo,
      );

      return { ...tokens, isNewUser: false, linked: true };
    }

    // 3. User baru — create user + oauth_account (dalam transaction)
    const filteredAvatar = await this.imageFilter.filterImageUrl(
      googleUser.picture,
    );

    const newUser = await this.db.transaction(async (tx: any) => {
      const newUsername = await this.resolveUniqueUsername(email.split("@")[0]);
      const [created] = await tx
        .insert(usersTable)
        .values({
          email,
          username: newUsername,
          password: null,
          fullName: googleUser.name ?? email.split("@")[0],
          avatarUrl: filteredAvatar,
          isEmailVerified: true,
          isActive: true,
        })
        .returning({ id: usersTable.id });

      await tx.insert(oauthAccountsTable).values({
        userId: created.id,
        provider: "google",
        providerUserId: googleUser.sub,
        email,
        displayName: googleUser.name ?? null,
        avatarUrl: filteredAvatar,
      });

      return created;
    });

    const tokens = await this.authService.generateTokenPair(
      newUser.id,
      clientType,
      undefined,
      deviceInfo,
    );

    return { ...tokens, isNewUser: true, linked: false };
  }

  private async resolveUniqueUsername(base: string): Promise<string> {
    return resolveUniqueUsername(this.adapter, base);
  }
}
