import { UnauthorizedException } from "@nestjs/common";

export type OAuthProvider = "github" | "google";

export interface OAuthProfile {
  email: string;
  displayName: string;
}

export function isOAuthProvider(value: string): value is OAuthProvider {
  return value === "github" || value === "google";
}

export function providerCredentials(provider: OAuthProvider): { clientId: string; clientSecret: string } {
  const clientId = provider === "github" ? process.env.GITHUB_CLIENT_ID : process.env.GOOGLE_CLIENT_ID;
  const clientSecret = provider === "github" ? process.env.GITHUB_CLIENT_SECRET : process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new UnauthorizedException(`${provider} OAuth is not configured`);
  return { clientId, clientSecret };
}

export function callbackUrl(provider: OAuthProvider): string {
  return `${process.env.MEMOAR_PUBLIC_URL ?? "http://localhost:4000"}/v1/auth/oauth/${provider}/callback`;
}

/**
 * Exchanges the callback's code for the one fact an account needs: a verified
 * address. Separated from the service so the account-resolution rules below it
 * can be read without four network calls in the way.
 */
export async function exchangeCodeForProfile(provider: OAuthProvider, code: string): Promise<OAuthProfile> {
  const { clientId, clientSecret } = providerCredentials(provider);
  const tokenEndpoint = provider === "github" ? "https://github.com/login/oauth/access_token" : "https://oauth2.googleapis.com/token";
  const tokenResponse = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret, code, redirect_uri: callbackUrl(provider),
      ...(provider === "google" ? { grant_type: "authorization_code" } : {}),
    }),
  });
  if (!tokenResponse.ok) throw new UnauthorizedException("OAuth token exchange failed");
  const tokenPayload = await tokenResponse.json() as { access_token?: string };
  if (!tokenPayload.access_token) throw new UnauthorizedException("OAuth provider returned no access token");

  const authorization = { authorization: `Bearer ${tokenPayload.access_token}`, accept: "application/json" };
  const profileEndpoint = provider === "github" ? "https://api.github.com/user" : "https://openidconnect.googleapis.com/v1/userinfo";
  const profileResponse = await fetch(profileEndpoint, { headers: authorization });
  if (!profileResponse.ok) throw new UnauthorizedException("OAuth profile lookup failed");
  const profile = await profileResponse.json() as { email?: string; email_verified?: boolean; name?: string; login?: string };

  // An address the provider has not verified is a claim, not a fact, and an
  // address is the whole of what an account is matched on here (see
  // resolveOAuthAccount). Google says so in the profile and the flag was never
  // read: a Google identity whose `email_verified` is false, offered for an
  // address that already has a password account on this archive, resolved
  // straight onto that account's identity row and signed the caller in to
  // somebody else's tenant.
  let email = provider === "google" && profile.email_verified !== true ? undefined : profile.email;
  if (!email && provider === "github") {
    const emailResponse = await fetch("https://api.github.com/user/emails", { headers: authorization });
    const emails = emailResponse.ok ? await emailResponse.json() as { email: string; primary?: boolean; verified?: boolean }[] : [];
    // Only a verified address: an unverified one is a claim the provider has
    // not checked, and this address is what an account is matched on.
    email = emails.find((candidate) => candidate.primary && candidate.verified)?.email
      ?? emails.find((candidate) => candidate.verified)?.email;
  }
  if (!email) throw new UnauthorizedException("OAuth provider did not supply a verified email");
  const normalizedEmail = email.toLowerCase();
  return { email: normalizedEmail, displayName: profile.name?.trim() || profile.login?.trim() || normalizedEmail };
}
