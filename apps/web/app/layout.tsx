import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import { ICONS, SHARE_CARD, SITE_DESCRIPTION, SITE_TITLE, SITE_URL } from '@/lib/site';
import { THEME_BOOT } from '@/lib/theme-boot';
import './globals.css';

// Every route shares one link preview (lib/site.ts). Next copies the openGraph title, description and image into the
// twitter tags.
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'Mimic',
  description: SITE_DESCRIPTION,
  openGraph: {
    type: 'website',
    siteName: 'Mimic',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [SHARE_CARD],
  },
  twitter: { card: 'summary_large_image' },
  icons: ICONS,
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#eef0f2' },
    { media: '(prefers-color-scheme: dark)', color: '#15171b' },
  ],
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The theme attribute is set before paint by THEME_BOOT, so the server markup can differ.
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600&family=Newsreader:opsz,wght@6..72,400;6..72,500&display=swap"
        />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant, first-party script that avoids a theme flash */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
