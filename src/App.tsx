import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapView } from './map/MapView';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <MapView />
    </QueryClientProvider>
  );
}
