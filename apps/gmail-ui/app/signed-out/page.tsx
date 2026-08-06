export const dynamic = "force-dynamic";

// Shown after logout or a failed/expired authorization. The Sign in link
// restarts the OAuth flow against the API.
export default async function SignedOut({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f6f8fc] px-4">
      <div className="w-full max-w-[420px] rounded-2xl border border-[#dadce0] bg-white px-10 py-9 text-center shadow-sm">
        <div className="mx-auto mb-4 flex items-center justify-center gap-1">
          <span className="material-symbols-outlined filled text-[30px] text-[#ea4335]">mail</span>
          <span className="text-[22px] font-medium tracking-tight text-[#5f6368]">Gmail</span>
        </div>
        <h1 className="text-[20px] text-[#202124]">You&rsquo;re signed out</h1>
        {reason && <p className="mt-2 text-[13px] leading-5 text-[#5f6368]">{reason}</p>}
        <a
          href="/oauth/login"
          className="mt-6 inline-block rounded-md bg-[#1a73e8] px-6 py-2.5 text-[14px] font-medium text-white hover:bg-[#1b66c9]"
        >
          Sign in
        </a>
      </div>
    </div>
  );
}
