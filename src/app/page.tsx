import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { supabase } from '@/lib/supabase';

export default function Dashboard() {
  const { data: session } = useSession();
  const router = useRouter();

  // Realtime subscription to work_sessions
  useEffect(() => {
    const channel = supabase
      .channel('public')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'work_sessions' }, (payload) => {
        console.log('New work session:', payload.new);
        // In production: update dashboard state via WebSocket or polling
      })
      .subscribe();

    return () => {
      channel.unsubscribe();
    };
  }, []);

  if (!session) {
    return (
      <div style={{ padding: '2rem' }}>
        <h1>🕙 Clocky Attendance Bot</h1>
        <p>🔒 <strong>Admin login required.</strong></p>
        <a href="/admin">Go to Admin Portal</a>
      </div>
    );
  }

  return (
    <div style={{ padding: '2rem' }}>
      <h1>🕙 Clocky Attendance Dashboard</h1>
      <p>Welcome, {session.user.email}</p>
      <a href="/admin">Admin Portal</a>
      <a href="/export-csv">Export CSV</a>
    </div>
  );
}