'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { verifySignature } from '@/lib/crypto';

export default function VerifyPage() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('session_id') || searchParams.get('id') || '';

  const [status, setStatus] = useState<'loading' | 'valid' | 'invalid' | 'notfound'>('loading');

  useEffect(() => {
    async function run() {
      const { data } = await fetchSessionById(sessionId);
      if (!data) {
        setStatus('notfound');
        return;
      }

      const payload = `${data.session_id}|${data.user_id}|${data.channel_id}|${data.start_iso}|${data.end_iso}|${data.duration_sec}`;
      const ok = verifySignature(payload, data.ed25519_signature, process.env.NEXT_PUBLIC_ED25519_PUBLIC_KEY || '');
      setStatus(ok ? 'valid' : 'invalid');
    }
    run();
  }, [sessionId]);

  if (status === 'loading') return <div style={{ padding: '2rem' }}>Loading…</div>;
  if (status === 'notfound') return <div style={{ padding: '2rem' }}>Session not found.</div>;
  if (status === 'invalid') return <div style={{ padding: '2rem', color: 'red' }}>Signature INVALID.</div>;

  return (
    <div style={{ padding: '2rem' }}>
      <h1>✅ Signature Verified</h1>
      <p>Session: <code>{sessionId}</code></p>
    </div>
  );
}

async function fetchSessionById(id: string): Promise<{ data: any }> {
  // In production: fetch from supabase via service client on server, or anon.
  // Client-side can't call RPCs with anon key; use a public select via RLS-safe view.
  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/voice_sessions?session_id=eq.${id}&select=*`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) return { data: null };
  const data = await res.json();
  if (Array.isArray(data) && data.length > 0) return { data: data[0] };
  if (Array.isArray(data) && data.length === 0) return { data: null };
  // maybe returned object directly
  if (data && data.session_id) return { data };
  return { data: null };
}