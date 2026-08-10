import { getDb } from "@/lib/db";
import { getProfileEmail } from "@/lib/store/meta";
import { validateAuthorize, isAuthorizeRequest, buildRedirect } from "@/lib/oauth/authorize";
import { consentInfoFor } from "@/lib/oauth/consent";
import { redirect } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The OAuth consent screen — a faithful stand-in for Google's real "… wants to
// access your Google Account" page. A bad request that we cannot trust the
// redirect for is shown inline; a protocol error we can, redirects back.

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function AuthorizePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const db = getDb();
  const result = validateAuthorize(db, {
    response_type: one(sp.response_type),
    client_id: one(sp.client_id),
    redirect_uri: one(sp.redirect_uri),
    scope: one(sp.scope),
    state: one(sp.state),
    code_challenge: one(sp.code_challenge),
    code_challenge_method: one(sp.code_challenge_method),
  });

  if (!isAuthorizeRequest(result)) {
    if (result.kind === "redirectable") {
      redirect(
        buildRedirect(result.redirectUri, { error: result.error, error_description: result.description, state: result.state }),
      );
    }
    return <ErrorCard title={result.title} detail={result.detail} />;
  }

  const account = getProfileEmail(db);
  const scopes = result.requestedScopes;

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f6f8fc] px-4 py-10">
      <div className="w-full max-w-[456px] rounded-[28px] border border-[#dadce0] bg-white px-10 py-8 shadow-[0_1px_3px_rgba(60,64,67,0.15)]">
        <GoogleWordmark />

        <h1 className="mt-4 text-[24px] leading-8 text-[#202124]">
          {result.client.name} wants to access your Google Account
        </h1>

        <div className="mt-4 flex items-center gap-2 text-[14px] text-[#3c4043]">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#a142f4] text-[13px] font-medium text-white">
            {account.charAt(0).toUpperCase()}
          </span>
          <span>{account}</span>
        </div>

        <p className="mt-6 text-[14px] leading-5 text-[#3c4043]">
          This will allow {result.client.name} to:
        </p>

        <ul className="mt-3 space-y-3">
          {scopes.map((scope) => {
            const info = consentInfoFor(scope);
            return (
              <li key={scope} className="flex items-start gap-4 text-[14px] leading-5 text-[#3c4043]">
                <span className="material-symbols-outlined mt-[1px] text-[20px] text-[#5f6368]" aria-hidden>
                  {info.icon}
                </span>
                <span>{info.title}</span>
              </li>
            );
          })}
        </ul>

        <p className="mt-6 text-[12px] leading-4 text-[#5f6368]">
          Make sure you trust {result.client.name}. You may be sharing sensitive info with this site
          or app. You can always see or remove access in your Google Account.
        </p>

        <form method="post" action="/oauth/authorize/decision" className="mt-8 flex items-center justify-end gap-2">
          <input type="hidden" name="client_id" value={result.client.client_id} />
          <input type="hidden" name="redirect_uri" value={result.redirectUri} />
          <input type="hidden" name="scope" value={result.scope} />
          <input type="hidden" name="response_type" value="code" />
          <input type="hidden" name="code_challenge" value={result.codeChallenge} />
          <input type="hidden" name="code_challenge_method" value={result.codeChallengeMethod} />
          {result.state !== undefined && <input type="hidden" name="state" value={result.state} />}
          <button
            type="submit"
            name="decision"
            value="deny"
            className="rounded-md px-6 py-2 text-[14px] font-medium text-[#1a73e8] hover:bg-[#f6fafe]"
          >
            Cancel
          </button>
          <button
            type="submit"
            name="decision"
            value="allow"
            className="rounded-md bg-[#1a73e8] px-6 py-2 text-[14px] font-medium text-white hover:bg-[#1b66c9]"
          >
            Allow
          </button>
        </form>
      </div>
    </div>
  );
}

function GoogleWordmark() {
  return (
    <div className="text-[22px] font-medium tracking-tight" aria-label="Google">
      <span style={{ color: "#4285f4" }}>G</span>
      <span style={{ color: "#ea4335" }}>o</span>
      <span style={{ color: "#fbbc05" }}>o</span>
      <span style={{ color: "#4285f4" }}>g</span>
      <span style={{ color: "#34a853" }}>l</span>
      <span style={{ color: "#ea4335" }}>e</span>
    </div>
  );
}

function ErrorCard({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f6f8fc] px-4 py-10">
      <div className="w-full max-w-[456px] rounded-[28px] border border-[#dadce0] bg-white px-10 py-8 shadow-[0_1px_3px_rgba(60,64,67,0.15)]">
        <GoogleWordmark />
        <h1 className="mt-4 text-[22px] leading-7 text-[#202124]">{title}</h1>
        <p className="mt-3 text-[14px] leading-5 text-[#3c4043]">{detail}</p>
        <p className="mt-6 text-[12px] leading-4 text-[#5f6368]">
          The developer of the application you were using has made a mistake in the authorization
          request. Nothing was shared.
        </p>
      </div>
    </div>
  );
}
