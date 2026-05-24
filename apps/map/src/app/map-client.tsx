'use client';

import dynamic from 'next/dynamic';

const MapView = dynamic(
  () => import('@/map/MapView').then((mod) => mod.MapView),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center w-full h-full bg-gray-50">
        <div className="text-center">
          <div className="w-8 h-8 border-3 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="mt-3 text-sm text-gray-500">Loading map...</p>
        </div>
      </div>
    ),
  },
);

export function MapClient() {
  return <MapView />;
}
