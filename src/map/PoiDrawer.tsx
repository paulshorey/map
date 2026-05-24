interface Props {
  poi: {
    name: string;
    category: string;
    description?: string;
    photo_url?: string;
  };
  onClose: () => void;
}

export function PoiDrawer({ poi, onClose }: Props) {
  return (
    <div className="absolute top-0 right-0 z-20 h-full w-80 max-w-full bg-white shadow-2xl border-l border-gray-200 flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <h2 className="text-lg font-semibold text-gray-900 truncate">
          {poi.name}
        </h2>
        <button
          onClick={onClose}
          className="p-1 rounded-md hover:bg-gray-100 transition-colors text-gray-500 cursor-pointer"
          aria-label="Close"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {poi.photo_url && (
          <img
            src={poi.photo_url}
            alt={poi.name}
            className="w-full h-48 object-cover"
          />
        )}
        <div className="p-4 space-y-3">
          <span className="inline-block rounded-full bg-blue-100 text-blue-700 px-3 py-0.5 text-xs font-medium">
            {poi.category}
          </span>
          {poi.description && (
            <p className="text-sm text-gray-600 leading-relaxed">
              {poi.description}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
