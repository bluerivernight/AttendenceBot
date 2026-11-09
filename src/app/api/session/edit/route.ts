import { NextRequest, NextResponse } from 'next-app-handler';
import { supabase } from '@/lib/supabase';
import { signPayload, canonicalString } from '@/lib/crypto';

export async function POST(req: NextRequest, res: NextResponse) {
  const body = await req.json();
  const { session_id, check_in, check_out, reason } = body;

  const { data: session, error: fetchErr } = await supabase.from('work_sessions').select('*').eq('id', session_id).single();
  if (fetchErr || !session) return res.json({ error: 'Session not found' }, { status: 404 });

  const previousJson = JSON.parse(JSON.stringify(session));
  const update: Record<string, any> = { manager_edited: true, updated_at: new Date().toISOString() };
  if (check_in) update.check_in_at = check_in;
  if (check_out) update.check_out_at = check_out;

  if (check_in || check_out) {
    const gross = update.check_out_at ? new Date(update.check_out_at).getTime() - new Date(update.check_in_at || session.check_in_at).getTime() : session.gross_duration_ms;
    update.gross_duration_ms = gross;
    const breakMs = session.break_duration_ms ?? 0;
    const netMs = Math.max(0, (gross ?? 0) - breakMs);
    update.net_duration_ms = netMs;
  }

  const { error } = await supabase.from('work_sessions').update(update).eq('id', session_id);
  if (error) return res.json({ error: error.message }, { status: 500 });

  await supabase.from('session_audit_logs').insert({
    session_id,
    modified_by_auth_id: (await supabase.auth.getUser()).data.user?.id,
    modified_by_discord_id: 'admin',
    previous_json: previousJson,
    new_json: { ...session, ...update },
    reason: reason || 'Admin edit',
    signature: signPayload(canonicalString({
      session_id,
      user_id: session.employee_id,
      channel_id: '',
      start_iso: update.check_in_at || session.check_in_at,
      end_iso: update.check_out_at || session.check_out_at || '',
      duration_sec: Math.floor((update.net_duration_ms ?? session.net_duration_ms) / 1000),
    }), process.env.ED25519_PRIVATE_KEY!),
  });

  return res.json({ success: true, session_id });
}