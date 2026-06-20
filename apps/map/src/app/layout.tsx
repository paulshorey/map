import type { Metadata, Viewport } from 'next';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'POI Map',
  description: 'Multi-provider interactive map with points of interest',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <meta name="referrer" content="strict-origin-when-cross-origin" />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
