import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4">
      <div className="text-center max-w-2xl">
        <h1 className="text-5xl font-bold tracking-tight mb-6">
          <span className="text-brand-400">TACKTCIX</span>
        </h1>
        <p className="text-xl text-gray-400 mb-4">
          The AI-native company operating system.
        </p>
        <p className="text-gray-500 mb-10 max-w-lg mx-auto">
          Create, operate, and scale an autonomous AI company from your browser.
          No VPS, Docker, or Kubernetes knowledge required.
        </p>
        <Link href="/onboarding" className="btn-primary inline-block text-lg px-10 py-4">
          Create Your AI Company
        </Link>
      </div>
    </div>
  );
}
