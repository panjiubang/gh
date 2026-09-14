'use client';

import dynamic from 'next/dynamic';

const ZssfPanel = dynamic(() => import('@/components/ZssfPanel'), { ssr: false });

export default function Page() {
  return <ZssfPanel />;
}
