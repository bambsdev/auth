// src/services/email.service.ts
//
// Kirim email via Resend API (pure fetch, zero SDK).
// Di dev mode (wrangler dev), skip API call dan log URL ke console.

import type { EmailConfig } from "../types/index";

export class EmailService {
  constructor(
    private readonly apiKey: string,
    private readonly appUrl: string,
    private readonly from: string,
    private readonly templates?: EmailConfig["templates"],
    private readonly resetPasswordBaseUrl?: string,
  ) {}

  /**
   * Kirim email verifikasi berisi link one-time.
   * @param to    - Email tujuan
   * @param token - Plain verification token (akan jadi query param)
   */
  async sendVerificationEmail(to: string, token: string): Promise<void> {
    const verifyUrl = `${this.appUrl}/auth/verify-email?token=${token}`;

    // Dev mode: RESEND_API_KEY belum di-set → log ke console saja
    if (!this.apiKey || this.apiKey === "dev") {
      console.log(`[email-dev] Verification URL untuk ${to}:`);
      console.log(`[email-dev] ${verifyUrl}`);
      return;
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        from: this.from,
        to: [to],
        subject: "Verifikasi Email",
        html: this.templates?.verification
          ? this.templates.verification(verifyUrl)
          : this.buildHtml(verifyUrl),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error("[email] Resend API error:", res.status, body);
      throw Object.assign(new Error("Gagal mengirim email verifikasi"), {
        code: "EMAIL_SEND_FAILED",
        status: 500,
      });
    }
  }

  /**
   * Kirim email verifikasi berisi kode OTP 6-digit.
   * Template `verification` dari consumer juga dipakai di sini —
   * consumer mengontrol tampilan, menerima `code` (string 6 digit) sebagai argumen.
   * @param to   - Email tujuan
   * @param code - Kode OTP 6-digit plain text
   */
  async sendVerificationCodeEmail(to: string, code: string): Promise<void> {
    // Dev mode
    if (!this.apiKey || this.apiKey === "dev") {
      console.log(`[email-dev] Verification CODE untuk ${to}: ${code}`);
      return;
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        from: this.from,
        to: [to],
        subject: "Kode Verifikasi Email",
        html: this.templates?.verification
          ? this.templates.verification(code)
          : this.buildVerificationCodeHtml(code),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error("[email] Resend API error (code):", res.status, body);
      throw Object.assign(new Error("Gagal mengirim kode verifikasi"), {
        code: "EMAIL_SEND_FAILED",
        status: 500,
      });
    }
  }

  /**
   * Kirim email reset password berisi link one-time.
   * Menggunakan `resetPasswordBaseUrl` (dari emailConfig consumer) jika ada,
   * fallback ke `appUrl` (base URL API).
   * @param to    - Email tujuan
   * @param token - Plain reset token (akan jadi query param)
   */
  async sendForgotPasswordEmail(to: string, token: string): Promise<void> {
    // Gunakan resetPasswordBaseUrl jika consumer mengonfigurasi,
    // fallback ke appUrl
    const baseUrl = this.resetPasswordBaseUrl ?? this.appUrl;
    const resetUrl = `${baseUrl}/auth/reset-password?token=${token}`;

    // Dev mode: log ke console saja
    if (!this.apiKey || this.apiKey === "dev") {
      console.log(`[email-dev] Reset Password URL untuk ${to}:`);
      console.log(`[email-dev] ${resetUrl}`);
      return;
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        from: this.from,
        to: [to],
        subject: "Reset Password",
        html: this.templates?.forgotPassword
          ? this.templates.forgotPassword(resetUrl)
          : this.buildResetPasswordHtml(resetUrl),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error("[email] Resend API error (reset-password):", res.status, body);
      throw Object.assign(new Error("Gagal mengirim email reset password"), {
        code: "EMAIL_SEND_FAILED",
        status: 500,
      });
    }
  }

  private buildHtml(verifyUrl: string): string {
    return `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
        <h2 style="color: #1a1a2e; margin-bottom: 16px;">Verifikasi Email Anda</h2>
        <p style="color: #444; line-height: 1.6;">
          Terima kasih telah mendaftar! Klik tombol di bawah untuk memverifikasi email Anda.
          Link ini berlaku selama <strong>15 menit</strong>.
        </p>
        <div style="text-align: center; margin: 32px 0;">
          <a href="${verifyUrl}"
             style="background: #4f46e5; color: #fff; padding: 14px 32px;
                    border-radius: 8px; text-decoration: none; font-weight: 600;
                    display: inline-block;">
            Verifikasi Email
          </a>
        </div>
        <p style="color: #888; font-size: 13px; line-height: 1.5;">
          Jika Anda tidak merasa mendaftar, abaikan email ini.<br>
          Atau salin link berikut ke browser Anda:<br>
          <a href="${verifyUrl}" style="color: #4f46e5; word-break: break-all;">${verifyUrl}</a>
        </p>
      </div>
    `;
  }

  private buildVerificationCodeHtml(code: string): string {
    return `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
        <h2 style="color: #1a1a2e; margin-bottom: 16px;">Kode Verifikasi Email</h2>
        <p style="color: #444; line-height: 1.6;">
          Terima kasih telah mendaftar! Gunakan kode di bawah untuk memverifikasi email Anda.
          Kode ini berlaku selama <strong>15 menit</strong>.
        </p>
        <div style="text-align: center; margin: 32px 0; padding: 24px; background: #f5f5ff; border-radius: 12px; border: 2px dashed #4f46e5;">
          <p style="color: #6b7280; font-size: 12px; letter-spacing: 2px; text-transform: uppercase; margin: 0 0 12px; font-weight: 600;">Kode Verifikasi</p>
          <div style="letter-spacing: 12px; font-size: 42px; font-weight: 800; color: #4f46e5; font-family: 'Courier New', monospace;">${code}</div>
          <p style="color: #9ca3af; font-size: 12px; margin: 12px 0 0;">Berlaku selama <strong style="color: #4f46e5;">15 menit</strong></p>
        </div>
        <p style="color: #888; font-size: 13px; line-height: 1.5;">
          Jika Anda tidak merasa mendaftar, abaikan email ini.
        </p>
      </div>
    `;
  }

  private buildResetPasswordHtml(resetUrl: string): string {
    return `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
        <h2 style="color: #1a1a2e; margin-bottom: 16px;">Reset Password</h2>
        <p style="color: #444; line-height: 1.6;">
          Kami menerima permintaan untuk mereset password akun Anda.
          Klik tombol di bawah untuk membuat password baru.
          Link ini berlaku selama <strong>15 menit</strong>.
        </p>
        <div style="text-align: center; margin: 32px 0;">
          <a href="${resetUrl}"
             style="background: #4f46e5; color: #fff; padding: 14px 32px;
                    border-radius: 8px; text-decoration: none; font-weight: 600;
                    display: inline-block;">
            Reset Password
          </a>
        </div>
        <p style="color: #888; font-size: 13px; line-height: 1.5;">
          Jika Anda tidak meminta reset password, abaikan email ini. Password Anda tidak akan berubah.<br>
          Atau salin link berikut ke browser Anda:<br>
          <a href="${resetUrl}" style="color: #4f46e5; word-break: break-all;">${resetUrl}</a>
        </p>
      </div>
    `;
  }
}
