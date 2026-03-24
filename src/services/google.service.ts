// src/services/google.service.ts
//
// Google OAuth service — handle web (Authorization Code) dan mobile (ID Token) flow.
// Account linking: satu email bisa dipakai register manual + Google.

import { eq, and } from "drizzle-orm";
import { users, oauthAccounts } from "../db/schema";
import { fail } from "../utils/error";
import type { DB } from "../db/client";
import type { AuthService } from "./auth.service";
import type { ImageFilterService } from "../utils/image-filter";
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
  constructor(
    private readonly db: DB,
    private readonly authService: AuthService,
    private readonly imageFilter: ImageFilterService,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly bucketPublicUrl?: string,
  ) {}

  // ── Web Flow: Generate Authorization URL ─────────────────────────────────

  getAuthorizationUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      access_type: "offline",
      prompt: "consent",
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  // ── Web Flow: Exchange Authorization Code → Access Token ─────────────────

  async exchangeCode(
    code: string,
    redirectUri: string,
  ): Promise<GoogleTokenResponse> {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
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
  // Mobile client (Expo) pakai Google Sign-In SDK yang menghasilkan idToken.
  // Kita verify via Google tokeninfo endpoint.

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

    // Cek audience — pastikan token ini ditujukan untuk app kita
    if (data.aud !== this.clientId) {
      fail("ID Token audience tidak sesuai", "GOOGLE_ID_TOKEN_INVALID_AUD");
    }

    // Cek expiry
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
  // Satu method untuk semua flow (web & mobile).
  // Return: JWT token pair + info apakah user baru atau existing.

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

    // 1. Cek apakah sudah ada oauth_account untuk Google sub ini
    const existingOAuth = await this.db.query.oauthAccounts.findFirst({
      where: and(
        eq(oauthAccounts.provider, "google"),
        eq(oauthAccounts.providerUserId, googleUser.sub),
      ),
    });

    if (existingOAuth) {
      // User sudah pernah login via Google — update profil terbaru
      // Filter avatar URL melalui AI sebelum simpan
      const filteredAvatar = await this.imageFilter.filterImageUrl(
        googleUser.picture,
      );

      await this.db
        .update(oauthAccounts)
        .set({
          email,
          displayName: googleUser.name ?? null,
          avatarUrl: googleUser.picture ?? null,
          updatedAt: new Date(),
        })
        .where(eq(oauthAccounts.id, existingOAuth.id));

      // Update profil di users — termasuk username jika masih kosong
      const existUser = await this.db.query.users.findFirst({
        where: eq(users.id, existingOAuth.userId),
        columns: { id: true, username: true, avatarUrl: true, fullName: true },
      });
      const userUpdates: Record<string, any> = {
        updatedAt: new Date(),
      };
      if (existUser) {
        if (!existUser.username) {
          userUpdates.username = await this.resolveUniqueUsername(
            email.split("@")[0],
          );
        }
        // Jangan timpa (overwrite) custom name / avatar yang mungkin diatur user
        if (!existUser.fullName && googleUser.name) {
          userUpdates.fullName = googleUser.name;
        }
        if (filteredAvatar) {
          const isCustomAvatar =
            this.bucketPublicUrl &&
            existUser.avatarUrl?.startsWith(this.bucketPublicUrl);
          if (!isCustomAvatar) {
            userUpdates.avatarUrl = filteredAvatar;
          }
        }
      }
      await this.db
        .update(users)
        .set(userUpdates)
        .where(eq(users.id, existingOAuth.userId));

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
      where: eq(users.email, email),
    });

    if (existingUser) {
      // User sudah daftar manual — LINK akun Google
      if (!existingUser.isActive) {
        fail("Akun telah dinonaktifkan", "ACCOUNT_DISABLED", 403);
      }

      // Insert oauth_account link
      await this.db.insert(oauthAccounts).values({
        userId: existingUser.id,
        provider: "google",
        providerUserId: googleUser.sub,
        email,
        displayName: googleUser.name ?? null,
        avatarUrl: googleUser.picture ?? null,
      });

      // Filter avatar URL melalui AI sebelum simpan ke users
      const filteredAvatar = await this.imageFilter.filterImageUrl(
        googleUser.picture,
      );

      // Update user: set email verified (Google sudah verify), update avatar, update name, set username if null
      const isCustomAvatar =
        this.bucketPublicUrl &&
        existingUser.avatarUrl?.startsWith(this.bucketPublicUrl);
      const linkUpdates: Record<string, any> = {
        isEmailVerified: true,
        fullName: googleUser.name ?? existingUser.fullName ?? null,
        avatarUrl: isCustomAvatar
          ? existingUser.avatarUrl
          : filteredAvatar ?? existingUser.avatarUrl ?? null,
        updatedAt: new Date(),
      };
      if (!existingUser.username) {
        linkUpdates.username = await this.resolveUniqueUsername(
          email.split("@")[0],
        );
      }
      await this.db
        .update(users)
        .set(linkUpdates)
        .where(eq(users.id, existingUser.id));

      const tokens = await this.authService.generateTokenPair(
        existingUser.id,
        clientType,
        undefined,
        deviceInfo,
      );

      return { ...tokens, isNewUser: false, linked: true };
    }

    // 3. User baru — create user + oauth_account (dalam transaction)
    // Filter avatar URL melalui AI sebelum simpan
    const filteredAvatar = await this.imageFilter.filterImageUrl(
      googleUser.picture,
    );
    const newUsername = await this.resolveUniqueUsername(email.split("@")[0]);
    const newUser = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(users)
        .values({
          email,
          username: newUsername,
          password: null, // OAuth-only user, no password
          fullName: googleUser.name ?? email.split("@")[0],
          avatarUrl: filteredAvatar,
          isEmailVerified: true, // Google sudah verify email
          isActive: true,
        })
        .returning({ id: users.id });

      await tx.insert(oauthAccounts).values({
        userId: created.id,
        provider: "google",
        providerUserId: googleUser.sub,
        email,
        displayName: googleUser.name ?? null,
        avatarUrl: googleUser.picture ?? null,
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

  // ── Resolve Unique Username ──────────────────────────────────────────────
  // Jika username sudah dipakai, kurangi 1 karakter dari belakang sampai unik.

  private async resolveUniqueUsername(base: string): Promise<string> {
    let candidate = base;
    while (candidate.length > 0) {
      const existing = await this.db.query.users.findFirst({
        where: eq(users.username, candidate),
        columns: { id: true },
      });
      if (!existing) return candidate;
      candidate = candidate.slice(0, -1);
    }
    // Fallback: gunakan UUID jika semua trimmed versions sudah terpakai
    return crypto.randomUUID().slice(0, 8);
  }
}
