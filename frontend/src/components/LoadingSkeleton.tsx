export function LoadingSkeleton() {
  return (
    <div className="space-y-6 animate-pulse" aria-label="Loading" role="status">
      {/* Stat cards skeleton */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="rounded-xl border border-gray-200 bg-gray-50 p-5 space-y-3">
            <div className="h-3.5 w-20 bg-gray-200 rounded" />
            <div className="h-7 w-12 bg-gray-200 rounded" />
            <div className="h-3 w-32 bg-gray-100 rounded" />
          </div>
        ))}
      </div>

      {/* Main content skeleton */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Approval list skeleton */}
        <div className="lg:col-span-2 space-y-3">
          <div className="h-5 w-36 bg-gray-200 rounded" />
          {[...Array(5)].map((_, i) => (
            <div key={i} className="rounded-xl border border-gray-200 p-5 space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-gray-200" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-3/4 bg-gray-200 rounded" />
                  <div className="h-3 w-1/3 bg-gray-100 rounded" />
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Activity feed skeleton */}
        <div className="space-y-3">
          <div className="h-5 w-28 bg-gray-200 rounded" />
          <div className="rounded-xl border border-gray-200 p-5 space-y-4">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="flex items-start gap-3">
                <div className="w-14 h-5 bg-gray-200 rounded" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 w-full bg-gray-200 rounded" />
                  <div className="h-3 w-1/3 bg-gray-100 rounded" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
