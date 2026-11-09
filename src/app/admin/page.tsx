'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';

export default function AdminPage() {
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ status: 'all', employee: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const pageSize = 25;

  useEffect(() => {
    fetchSessions();
  }, [filter, page]);

  async function fetchSessions() {
    setLoading(true);
    const from = filter.from || '1970-01-01';
    const to = filter.to || new Date().toISOString();

    let query = supabase
      .from('work_sessions')
      .select('*, profiles(discord_user_id, full_name, timezone)', { count: 'exact' })
      .gte('check_in_at', from)
      .lte('check_in_at', to)
      .order('check_in_at', { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);

    if (filter.status !== 'all') {
      query = query.eq('status', filter.status);
    }
    if (filter.employee) {
      query = query.ilike('profiles.discord_user_id', `%${filter.employee}%`);
    }

    const { data, count, error } = await query;
    if (error) console.error(error);
    setSessions(data || []);
    setLoading(false);
  }

  async function exportCSV() {
    let query = supabase
      .from('work_sessions')
      .select('*, profiles(discord_user_id, full_name, timezone)')
      .gte('check_in_at', filter.from || '1970-01-01')
      .lte('check_in_at', filter.to || new Date().toISOString())
      .order('check_in_at', { ascending: false });

    if (filter.status !== 'all') query = query.eq('status', filter.status);
    if (filter.employee) query = query.ilike('profiles.discord_user_id', `%${filter.employee}%`);

    const { data } = await query;
    if (!data) return;

    const headers = [
      'Session UUID', 'Employee Name', 'Discord ID', 'Check-In (UTC)', 'Check-In (Local)', 'Check-Out (Local)',
      'Employee Timezone', 'Gross Duration (mins)', 'Break Duration (mins)', 'Net Work Duration (mins)',
      'Manager Edited', 'Ed25519 Signature',
    ];

    const rows = data.map((s) => {
      const p = s.profiles;
      return [
        s.id,
        p.full_name ?? p.discord_user_id,
        p.discord_user_id,
        s.check_in_at,
        new Date(s.check_in_at).toLocaleString(undefined, { timeZone: p.timezone }),
        s.check_out_at ? new Date(s.check_out_at).toLocaleString(undefined, { timeZone: p.timezone }) : '',
        p.timezone,
        Math.round((s.gross_duration_ms ?? 0) / 60000),
        Math.round((s.break_duration_ms ?? 0) / 60000),
        Math.round((s.net_duration_ms ?? 0) / 60000),
        s.manager_edited ? 'true' : 'false',
        '', // signature in voice_sessions
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',');
    });

    const blob = new Blob([headers.join(',') + '\n' + rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `attendance-${Date.now()}.csv`;
    link.click();
  }

  async function handleEdit(s: any) {
    // In production: open modal with edit form calling /api/session/edit
    const newCheckOut = prompt(`Edit check-out for ${s.id} (ISO):`, s.check_out_at);
    if (!newCheckOut) return;

    await fetch('/api/session/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: s.id, check_out_at: newCheckOut, reason: 'Admin edit' }),
    });
    fetchSessions();
  }

  return (
    <div style={{ padding: '2rem' }}>
      <h1>Admin Portal</h1>

      <div style={{ marginBottom: '1rem', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
          <option value="all">All Status</option>
          <option value="working">Working</option>
          <option value="on_break">On Break</option>
          <option value="completed">Completed</option>
        </select>
        <input
          type="text"
          placeholder="Filter by Discord ID"
          value={filter.employee}
          onChange={(e) => setFilter({ ...filter, employee: e.target.value })}
        />
        <input
          type="date"
          value={filter.from?.split('T')[0] || ''}
          onChange={(e) => setFilter({ ...filter, from: e.target.value + 'T00:00:00.000Z' })}
        />
        <input
          type="date"
          value={filter.to?.split('T')[0] || ''}
          onChange={(e) => setFilter({ ...filter, to: e.target.value + 'T23:59:59.999Z' })}
        />
        <button onClick={exportCSV}>Export CSV</button>
      </div>

      {loading ? (
        <div>Loading…</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left' }}>
              <th>Session</th>
              <th>Employee</th>
              <th>Check-In (UTC)</th>
              <th>Check-Out (UTC)</th>
              <th>Status</th>
              <th>Gross (m)</th>
              <th>Break (m)</th>
              <th>Net (m)</th>
              <th>Edited</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id} style={{ borderTop: '1px solid #eee' }}>
                <td>{s.id.slice(0, 8)}…</td>
                <td>{s.profiles?.full_name ?? s.profiles?.discord_user_id}</td>
                <td>{new Date(s.check_in_at).toLocaleString()}</td>
                <td>{s.check_out_at ? new Date(s.check_out_at).toLocaleString() : '—'}</td>
                <td>{s.status}</td>
                <td>{Math.round((s.gross_duration_ms ?? 0) / 60000)}</td>
                <td>{Math.round((s.break_duration_ms ?? 0) / 60000)}</td>
                <td>{Math.round((s.net_duration_ms ?? 0) / 60000)}</td>
                <td>{s.manager_edited ? '✅' : '❌'}</td>
                <td><button onClick={() => handleEdit(s)}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
        <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
        <button onClick={() => setPage((p) => p + 1)}>Next</button>
      </div>
    </div>
  );
}