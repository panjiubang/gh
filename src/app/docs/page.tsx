import type { Metadata } from 'next';
import DocsClient from './DocsClient';
import { ENDPOINT_COUNT } from './apiCatalog';

export const metadata: Metadata = {
  title: 'Documentation & API Reference',
  description: `Official 观寰 documentation — self-hosting guide, interface reference, and the complete API reference for all ${ENDPOINT_COUNT} endpoints covering aviation, maritime, seismic, conflict, cyber, and OSINT feeds. No API key required.`,
  alternates: { canonical: '/docs' },
  openGraph: {
    title: '观寰 — Documentation & API Reference',
    description: `Self-hosting guide, interface reference, and the complete API reference for all ${ENDPOINT_COUNT} 观寰 endpoints.`,
    url: '/docs',
    type: 'article',
  },
};

export default function DocsPage() {
  return <DocsClient />;
}
