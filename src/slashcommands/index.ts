import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  AutocompleteInteraction,
} from 'discord.js';
import { Database } from '../supabase/database.types';
import { supabase } from '../bot/voice-listener';
import { canonicalString, signPayload } from '../lib/crypto';

export const commands = [
  new SlashCommandBuilder()
    .setName('timezone')
    .setDescription('Set or view your IANA timezone')
    .addSubcommand((sub) =>
      sub.setName('set').setDescription('Set your timezone').addStringOption((opt) =>
        opt.setName('timezone').setDescription('IANA timezone (e.g. America/New_York)').setRequired(true).setAutocomplete(true),
      ),
    )
    .addSubcommand((sub) => sub.setName('view').setDescription('View your current timezone')),

  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Manage server attendance settings (Admin/Manager only)')
    .addSubcommand((sub) =>
      sub.setName('set').setDescription('Update a setting').addStringOption((opt) =>
        opt.setName('key').setDescription('Setting to change').setRequired(true).addChoices(
          { name: 'Attendance Logs Channel', value: 'attendance_logs_channel_id' },
          { name: 'Manager Role(s)', value: 'manager_role_ids' },
          { name: 'Tracked Voice Channels', value: 'tracked_voice_channel_ids' },
          { name: 'Auto-Checkout Inactivity (min)', value: 'auto_checkout_inactivity_minutes' },
          { name: 'Default Timezone', value: 'default_timezone' },
        ),
      ).addStringOption((opt) => opt.setName('value').setDescription('New value (comma-separated for arrays)').setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName('view').setDescription('View current config')),

  new SlashCommandBuilder()
    .setName('session')
    .setDescription('Manager session corrections')
    .addSubcommand((sub) =>
      sub.setName('edit').setDescription('Edit an existing session').addStringOption((opt) =>
        opt.setName('session_id').setDescription('Session UUID').setRequired(true),
      ).addStringOption((opt) => opt.setName('check_in').setDescription('New check-in ISO timestamp'))
      .addStringOption((opt) => opt.setName('check_out').setDescription('New check-out ISO timestamp'))
      .addIntegerOption((opt) => opt.setName('break_duration_minutes').setDescription('New break duration in minutes'))
      .addStringOption((opt) => opt.setName('reason').setDescription('Reason for edit').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName('add').setDescription('Manually add a completed session').addStringOption((opt) =>
        opt.setName('employee_id').setDescription('Discord user ID').setRequired(true),
      ).addStringOption((opt) => opt.setName('check_in').setDescription('Check-in ISO timestamp').setRequired(true))
      .addStringOption((opt) => opt.setName('check_out').setDescription('Check-out ISO timestamp').setRequired(true))
      .addIntegerOption((opt) => opt.setName('break_minutes').setDescription('Break duration in minutes').setRequired(true))
      .addStringOption((opt) => opt.setName('reason').setDescription('Reason for manual entry').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName('force-checkout').setDescription('Force checkout a stuck session').addStringOption((opt) =>
        opt.setName('session_id').setDescription('Session UUID').setRequired(true),
      ).addStringOption((opt) => opt.setName('reason').setDescription('Reason for force checkout').setRequired(true)),
    ),

  new SlashCommandBuilder()
    .setName('export')
    .setDescription('Export attendance data as CSV (Manager/Admin only)')
    .addSubcommand((sub) =>
      sub.setName('csv').setDescription('Export sessions as CSV').addStringOption((opt) =>
        opt.setName('range').setDescription('Date range').setRequired(false).addChoices(
          { name: 'Today', value: 'today' },
          { name: 'This Week', value: 'week' },
          { name: 'This Month', value: 'month' },
          { name: 'All Time', value: 'all' },
        ),
      ),
    ),
].map((cmd) => cmd.toJSON());

export async function handleSlashCommand(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();
  const group = interaction.options.getSubcommandGroup(false);

  const userProfile = await fetchProfile(interaction.user.id);
  const isStaff = userProfile && (userProfile.tier === 'manager' || userProfile.tier === 'super_admin');

  // --- /timezone ---
  if (interaction.commandName === 'timezone') {
    if (sub === 'set') {
      const tz = interaction.options.getString('timezone', true);
      if (!isValidIANA(tz)) {
        return interaction.reply({ content: '⚠️ Invalid IANA timezone. Example: America/New_York', ephemeral: true });
      }
      await supabase.from('profiles').update({ timezone: tz, updated_at: new Date().toISOString() }).eq('id', userProfile!.id);
      return interaction.reply({ content: `✅ Timezone set to **${tz}**`, ephemeral: true });
    }
    if (sub === 'view') {
      return interaction.reply({ content: `🕐 Your timezone: **${userProfile?.timezone ?? 'UTC'}**`, ephemeral: true });
    }
  }

  // --- /config (staff only) ---
  if (interaction.commandName === 'config') {
    if (!isStaff) return interaction.reply({ content: '⚠️ Staff only.', ephemeral: true });
    if (sub === 'view') {
      const { data: config } = await supabase.from('guild_configs').select('*').eq('guild_id', interaction.guildId).single();
      if (!config) return interaction.reply({ content: 'No config found.', ephemeral: true });
      const lines = Object.entries(config).filter(([k]) => k !== 'id').map(([k, v]) => `**${k}**: ${JSON.stringify(v)}`);
      return interaction.reply({ embeds: [new EmbedBuilder().setTitle('Server Config').setDescription(lines.join('\n')).setColor(0x3498db)], ephemeral: true });
    }
    if (sub === 'set') {
      const key = interaction.options.getString('key', true);
      const value = interaction.options.getString('value', true);
      const update: Record<string, any> = { updated_at: new Date().toISOString() };
      if (key === 'attendance_logs_channel_id') update[key] = value;
      else if (key === 'manager_role_ids') update[key] = value.split(',').map((s) => s.trim());
      else if (key === 'tracked_voice_channel_ids') update[key] = value.split(',').map((s) => s.trim());
      else if (key === 'auto_checkout_inactivity_minutes') update[key] = parseInt(value, 10);
      else if (key === 'default_timezone') update[key] = value;
      const { error } = await supabase.from('guild_configs').upsert({ guild_id: interaction.guildId!, ...update });
      if (error) return interaction.reply({ content: `⚠️ ${error.message}`, ephemeral: true });
      return interaction.reply({ content: `✅ Updated **${key}**`, ephemeral: true });
    }
  }

  // --- /session (staff only) ---
  if (interaction.commandName === 'session') {
    if (!isStaff) return interaction.reply({ content: '⚠️ Staff only.', ephemeral: true });

    if (sub === 'edit') {
      const sessionId = interaction.options.getString('session_id', true);
      const checkIn = interaction.options.getString('check_in');
      const checkOut = interaction.options.getString('check_out');
      const breakMin = interaction.options.getInteger('break_duration_minutes');
      const reason = interaction.options.getString('reason', true);

      const { data: session, error: fetchErr } = await supabase.from('work_sessions').select('*').eq('id', sessionId).single();
      if (fetchErr || !session) return interaction.reply({ content: '⚠️ Session not found.', ephemeral: true });

      const previousJson = JSON.parse(JSON.stringify(session));
      const update: Record<string, any> = { manager_edited: true, updated_at: new Date().toISOString() };
      if (checkIn) update.check_in_at = checkIn;
      if (checkOut) update.check_out_at = checkOut;
      if (breakMin !== null) update.break_duration_ms = breakMin * 60000;

      // recompute net_duration_ms
      if (checkIn || checkOut || breakMin !== null) {
        const gross = update.check_out_at ? new Date(update.check_out_at).getTime() - new Date(update.check_in_at || session.check_in_at).getTime() : session.gross_duration_ms;
        update.gross_duration_ms = gross;
        update.net_duration_ms = Math.max(0, (gross ?? 0) - (update.break_duration_ms ?? session.break_duration_ms));
      }

      const { error } = await supabase.from('work_sessions').update(update).eq('id', sessionId);
      if (error) return interaction.reply({ content: `⚠️ ${error.message}`, ephemeral: true });

      // audit log
      await supabase.from('session_audit_logs').insert({
        session_id: sessionId,
        modified_by_auth_id: (await supabase.auth.getUser()).data.user!.id,
        modified_by_discord_id: interaction.user.id,
        previous_json: previousJson,
        new_json: { ...session, ...update },
        reason,
        signature: signPayload(canonicalString({
          session_id: sessionId,
          user_id: session.employee_id,
          channel_id: '',
          start_iso: update.check_in_at || session.check_in_at,
          end_iso: update.check_out_at || session.check_out_at || '',
          duration_sec: Math.floor((update.net_duration_ms ?? session.net_duration_ms) / 1000),
        }), process.env.ED25519_PRIVATE_KEY!),
      });

      return interaction.reply({ content: '✅ Session updated and audited.', ephemeral: true });
    }

    if (sub === 'add') {
      const empDiscordId = interaction.options.getString('employee_id', true);
      const checkIn = interaction.options.getString('check_in', true);
      const checkOut = interaction.options.getString('check_out', true);
      const breakMin = interaction.options.getInteger('break_minutes', true);
      const reason = interaction.options.getString('reason', true);

      const { data: emp } = await supabase.from('profiles').select('id').eq('discord_user_id', empDiscordId).single();
      if (!emp) return interaction.reply({ content: '⚠️ Employee not found.', ephemeral: true });

      const grossMs = new Date(checkOut).getTime() - new Date(checkIn).getTime();
      const breakMs = breakMin * 60000;
      const netMs = Math.max(0, grossMs - breakMs);

      const { data: newSession, error } = await supabase
        .from('work_sessions')
        .insert({
          employee_id: emp.id,
          guild_id: interaction.guildId!,
          check_in_at: checkIn,
          check_out_at: checkOut,
          status: 'completed',
          gross_duration_ms: grossMs,
          break_duration_ms: breakMs,
          net_duration_ms: netMs,
          manager_edited: true,
        })
        .select()
        .single();
      if (error) return interaction.reply({ content: `⚠️ ${error.message}`, ephemeral: true });

      await supabase.from('session_audit_logs').insert({
        session_id: newSession.id,
        modified_by_auth_id: (await supabase.auth.getUser()).data.user!.id,
        modified_by_discord_id: interaction.user.id,
        previous_json: {},
        new_json: newSession,
        reason,
        signature: signPayload(canonicalString({
          session_id: newSession.id,
          user_id: emp.id,
          channel_id: '',
          start_iso: checkIn,
          end_iso: checkOut,
          duration_sec: Math.floor(netMs / 1000),
        }), process.env.ED25519_PRIVATE_KEY!),
      });

      return interaction.reply({ content: `✅ Session added: \`${newSession.id}\``, ephemeral: true });
    }

    if (sub === 'force-checkout') {
      const sessionId = interaction.options.getString('session_id', true);
      const reason = interaction.options.getString('reason', true);
      const { error } = await supabase.rpc('rpc_checkout_session', { p_session_id: sessionId });
      if (error) return interaction.reply({ content: `⚠️ ${error.message}`, ephemeral: true });
      return interaction.reply({ content: '✅ Session force-checked out.', ephemeral: true });
    }
  }

  // --- /export csv (staff only) ---
  if (interaction.commandName === 'export') {
    if (!isStaff) return interaction.reply({ content: '⚠️ Staff only.', ephemeral: true });
    if (sub === 'csv') {
      const range = interaction.options.getString('range') || 'week';
      const since = rangeStart(range);
      const { data: sessions } = await supabase
        .from('work_sessions')
        .select('*, profiles(discord_user_id, full_name, timezone)')
        .gte('check_in_at', since)
        .eq('status', 'completed');

      const csv = generateCSV(sessions || []);
      return interaction.reply({ content: `✅ CSV generated (${sessions?.length ?? 0} rows). Use dashboard for download.`, ephemeral: true });
    }
  }
}

export async function handleAutocomplete(interaction: AutocompleteInteraction) {
  if (interaction.commandName === 'timezone' && interaction.options.getSubcommand() === 'set') {
    const focused = interaction.options.getFocused(true);
    const ianaTimezones = [
      'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
      'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
      'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Dubai', 'Asia/Jakarta',
      'Australia/Sydney', 'Pacific/Auckland', 'UTC',
    ];
    const filtered = ianaTimezones.filter((tz) => tz.toLowerCase().includes(focused.value.toLowerCase())).slice(0, 25);
    await interaction.respond(filtered.map((tz) => ({ name: tz, value: tz })));
  }
}

// ---- helpers ----

async function fetchProfile(discordUserId: string): Promise<Database['public']['Tables']['profiles']['Row'] | null> {
  const { data } = await supabase.from('profiles').select('*').eq('discord_user_id', discordUserId).single();
  return data ?? null;
}

function isValidIANA(tz: string): boolean {
  try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; } catch { return false; }
}

function rangeStart(range: string): string {
  const now = new Date();
  switch (range) {
    case 'today': return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    case 'week': return new Date(now.getTime() - 7 * 86400000).toISOString();
    case 'month': return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    default: return '1970-01-01T00:00:00.000Z';
  }
}

function generateCSV(sessions: any[]): string {
  const headers = [
    'Session UUID', 'Employee Name', 'Discord ID', 'Check-In (UTC)', 'Check-In (Local)', 'Check-Out (Local)',
    'Employee Timezone', 'Gross Duration (mins)', 'Break Duration (mins)', 'Net Work Duration (mins)',
    'Manager Edited (Boolean)', 'Ed25519 Signature',
  ];
  const rows = sessions.map((s) => {
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
      '', // signature stored in voice_sessions if VC session
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',');
  });
  return [headers.join(','), ...rows].join('\n');
}