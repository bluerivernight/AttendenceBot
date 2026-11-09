import { ButtonInteraction, ChatInputInputType, ChatInputCommandInteraction } from 'discord.js';
import { Database } from '../supabase/database.types';
import { canonicalString, signPayload, verifySignature } from '../lib/crypto';

// types from supabase
type Profile = Database['public']['Tables']['profiles']['Row'];
type WorkSession = Database['public']['Tables']['work_sessions']['Row'];
type BreakLog = Database['public']['Tables']['break_logs']['Row'];

export async function handleDutyStatus(interaction: ButtonInteraction) {
  const userId = interaction.user.id;
  const profile = await fetchProfile(userId);
  if (!profile) {
    return interaction.reply({ content: '⚠️ Profile not found. Contact admin.', ephemeral: true });
  }

  const nowUtc = new Date().toISOString();
  const session = await fetchOpenSession(profile.id, interaction.guildId!);

  if (session && session.status === 'working') {
    // already checked in, show status
    const breakDuration = await fetchBreakDuration(profile.id, session.id);
    const elapsedMs = new Date(session.check_out_at ?? nowUtc).getTime() - new Date(session.check_in_at).getTime();

    const lines = [
      `📊 **Status: Checked In**`,
      `Active session elapsed: ${formatDurationMs(elapsedMs)}`,
      `Break time: ${formatDurationMs(breakDuration)}`,
      `Total hours today: ${formatDurationMs(breakDuration + elapsedMs)}`,
      `Local: ${localizeTimestamp(profile.timezone)}`,
    ];
    return interaction.reply({ embeds: [buildStatusEmbed('3498db', lines)], flags: 64 });
  }

  if (session && session.status === 'on_break') {
    const breakRec = await fetchActiveBreak(profile.id, session.id);
    const resumedAt = breakRec?.end_iso ?? nowUtc;
    const elapsedMs = new Date(nowUtc).getTime() - new Date(session.check_in_at).getTime() - (breakRec?.durationMs ?? 0);
    const netMs = Math.max(0, elapsedMs - breakRec?.durationMs ?? 0);

    const lines = [
      `📊 **Status: On Break**`,
      `Active session elapsed: ${formatDurationMs(elapsedMs)}`,
      `Break resumed at: ${formatTimeLocal(resumedAt, profile.timezone)}`,
      `Net work time: ${formatDurationMs(netMs)}`,
      `Total hours logged: ${formatDurationMs(netMs + (breakRec?.durationMs ?? 0))}`,
      `Local: ${localizeTimestamp(profile.timezone)}`,
    ];
    return interaction.reply({ embeds: [buildStatusEmbed('e67e22', lines)], flags: 64 });
  }

  // not checked in
  return interaction.reply({ embeds: [buildStatusEmbed('5793266', ['📊 **Status: Not Checked In**', 'Use **Check in** to start tracking time.']]), flags: 64 });
}

export async function handleDutyCheckIn(interaction: ButtonInteraction) {
  const userId = interaction.user.id;
  const profile = await fetchProfile(userId);
  if (!profile) {
    return interaction.reply({ content: '⚠️ Profile not found.', ephemeral: true });
  }

  // interaction locking: simple guard per user
  const lockingKey = `duty-lock-${userId}`;
  // In production, use redis or DB lock, but here we rely on DB atomicity

  // Check for open session
  const openSession = await fetchOpenSession(profile.id, interaction.guildId!);
  if (openSession && openSession.status !== 'completed') {
    return interaction.reply({ content: '⚠️ You already have an open session. Use Break / resume or Check out first.', ephemeral: true });
  }

  // Insert new work session
  const { data, error } = await supabase
    .from('work_sessions')
    .insert({
      employee_id: profile.id,
      guild_id: interaction.guildId!,
      check_in_at: new Date().toISOString(),
      status: 'working',
    })
    .select()
    .single();

  if (error) throw error;

  // Update duty panel in channel
  await updateDutyPanelCounters(interaction.guildId!);

  // Ephemeral status reply
  const lines = [
    `📊 **Status: Checked In**`,
    `Check-in (UTC): ${new Date(data.check_in_at).toISOString()}`,
    `Session: ${data.id}`,
    `Local: ${localizeTimestamp(profile.timezone)}`,
  ];
  return interaction.reply({ embeds: [buildStatusEmbed('2ecc71', lines)], flags: 64 });
}

export async function handleDutyBreakToggle(interaction: ButtonInteraction) {
  const userId = interaction.user.id;
  const profile = await fetchProfile(userId);
  if (!profile) {
    return interaction.reply({ content: '⚠️ Profile not found.', ephemeral: true });
  }

  const session = await fetchOpenSession(profile.id, interaction.guildId!);
  if (!session || session.status !== 'working') {
    return interaction.reply({ content: '⚠️ You are not currently checked in.', ephemeral: true });
  }

  // Check for existing open break
  const activeBreak = await fetchActiveBreak(profile.id, session.id);

  if (activeBreak) {
    // Resume from break — close the break_log
    await supabase
      .from('break_logs')
      .update({ end_iso: new Date().toISOString(), duration_ms: new Date().getTime() - new Date(activeBreak.start_iso).getTime() })
      .eq('id', activeBreak.id);

    // Update session break duration total
    await supabase
      .from('work_sessions')
      .update({ break_duration_ms: (session.break_duration_ms ?? 0) + activeBreak.duration_ms, updated_at: new Date().toISOString() })
      .eq('id', session.id);

    const lines = [
      `📊 **Status: Resumed from Break**`,
      `Break ended at: ${new Date().toLocaleTimeString()}`,
      `Added break duration: ${formatDurationMs(activeBreak.duration_ms)}`,
      `Net work time: ${formatDurationMs(session.net_duration_ms)}`,
      `Local: ${localizeTimestamp(profile.timezone)}`,
    ];
    return interaction.reply({ embeds: [buildStatusEmbed('2ecc71', lines)], flags: 64 });
  } else {
    // Go on break — insert break_log row
    const { data, error } = await supabase
      .from('break_logs')
      .insert({
        session_id: session.id,
        employee_id: profile.id,
        start_iso: new Date().toISOString(),
        duration_ms: 0,
      })
      .select()
      .single();

    if (error) throw error;

    await updateDutyPanelCounters(interaction.guildId!);

    const lines = [
      `📊 **Status: On Break**`,
      `Break started at: ${new Date().toLocaleTimeString()}`,
      `Session: ${session.id}`,
      `Local: ${localizeTimestamp(profile.timezone)}`,
    ];
    return interaction.reply({ embeds: [buildStatusEmbed('e67e22', lines)], flags: 64 });
  }
}

export async function handleDutyCheckOut(interaction: ButtonInteraction) {
  const userId = interaction.user.id;
  const profile = await fetchProfile(userId);
  if (!profile) {
    return interaction.reply({ content: '⚠️ Profile not found.', ephemeral: true });
  }

  const session = await fetchOpenSession(profile.id, interaction.guildId!);
  if (!session) {
    return interaction.reply({ content: '⚠️ No open session found.', ephemeral: true });
  }

  // 1) Close any open break first
  const activeBreak = await fetchActiveBreak(profile.id, session.id);
  if (activeBreak) {
    await supabase
      .from('break_logs')
      .update({ end_iso: new Date().toISOString(), duration_ms: new Date().getTime() - new Date(activeBreak.start_iso).getTime() })
      .eq('id', activeBreak.id);

    await supabase
      .from('work_sessions')
      .update({ break_duration_ms: (session.break_duration_ms ?? 0) + activeBreak.duration_ms, updated_at: new Date().toISOString() })
      .eq('id', session.id);
  }

  // 2) Finalize session
  const finalized = await supabase.rpc('rpc_checkout_session', { p_session_id: session.id });

  await updateDutyPanelCounters(interaction.guildId!);

  const { data } = finalized;
  const netMins = Math.round((data.net_duration_ms ?? 0) / 60000);

  const lines = [
    `📊 **Session Closed**`,
    `Check-in: ${new Date(data.check_in_at).toLocaleString()}`,
    `Check-out: ${new Date(data.check_out_at ?? data.check_in_at).toLocaleString()}`,
    `Gross duration: ${formatDurationMs(data.gross_duration_ms)}`,
    `Break duration: ${formatDurationMs(data.break_duration_ms)}`,
    `Net work duration: ${formatDurationMs(data.net_duration_ms)}`,
    `Total: ${netMins} min`,
    `Local: ${localizeTimestamp(profile.timezone)}`,
  ];

  return interaction.reply({ embeds: [buildStatusEmbed('2ecc71', lines)], flags: 64 });
}

// ---- helpers ----

async function fetchProfile(discordUserId: string): Promise<Profile | null> {
  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('discord_user_id', discordUserId)
    .single();
  return data ?? null;
}

async function fetchOpenSession(employeeId: string, guildId?: string): Promise<WorkSession | null> {
  const q = supabase.from('work_sessions').select('*').eq('employee_id', employeeId).eq('status', 'working').order('check_in_at', { ascending: false }).limit(1);
  const { data } = await q;
  return data ?? null;
}

async function fetchActiveBreak(employeeId: string, sessionId: string): Promise<BreakLog | null> {
  const { data } = await supabase
    .from('break_logs')
    .select('*')
    .eq('session_id', sessionId)
    .eq('end_iso', null)
    .single();
  return data ?? null;
}

async function fetchBreakDuration(employeeId: string, sessionId: string): Promise<number> {
  const { data } = await supabase
    .from('break_logs')
    .select('duration_ms')
    .eq('session_id', sessionId)
    .where('end_iso', 'not null');
  if (!data || data.length === 0) return 0;
  return data.reduce((sum, b) => sum + (b.duration_ms ?? 0), 0);
}

function formatTimeLocal(iso: string, timezone: string): string {
  // In production: use IANA timezone library (date-fns-tz). Here simple offset.
  const d = new Date(iso);
  return `${d.toLocaleTimeString('en-US', { timeZone: timezone })}`;
}

function localizeTimestamp(timezone: string): string {
  return new Date().toLocaleTimeString('en-US', { timeZone: timezone });
}

// In-memory-ish supabase client — will be injected from bot entry
export const supabase = supaCreateClient();

function supaCreateClient() {
  // placeholder; real client initialized in bot/index.ts
  return { from: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }), rpc: async () => ({ data: null }), from: () => ({}) });
}