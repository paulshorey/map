import { notFound } from 'next/navigation';
import LineageClient from './lineage-client';

export default function LineagePage() {
  if (process.env.NODE_ENV !== 'development' && process.env.ENABLE_ADMIN_LINEAGE !== 'true') notFound();
  return <LineageClient />;
}
