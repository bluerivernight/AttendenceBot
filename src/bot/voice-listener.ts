import { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { Database } from '../supabase/database.types';
import { canonicalString, signPayload, verifySignature } from '../lib/crypto';

// supabase client - will be injected from bot/index.ts
export const supabase = supaCreateClient();

type Profile = Database['public']['Tables']['profiles']['Row'];
type VoiceSession = Database['public']['Tables']['voice_sessions']['Row'];

export class AttendanceBotClient {
  client: Client;

  constructor(client: Client) {
    this.client = client;
    this.setupVoiceEvents();
  }

  private setupVoiceEvents() {
    this.client.on('voiceStateUpdate', async (oldState, newState) => {
      if (!newState.member) return;

      const profile = await fetchProfile(newState.member.user.id);
      if (!profile) return;

      const guildConfig = await fetchGuildConfig(newState.guildId!);
      if (!guildConfig || !guildConfig.tracked_voice_channel_ids?.includes(newState.channelId)) return;

      if (oldState.channelId && newState.channelId) {
        // left a tracked channel
        await this.handleVoiceLeave(oldState, newState, profile);
      } else if (newState.channelId) {
        // joined a tracked channel - do nothing for logging
      }
    });
  }

  private async handleVoiceLeave(oldState, newState, profile: Profile) {
    const sessionId = `${newState.member.user.id}-${newState.channel.id}`;
    const session = await supabase.from('voice_sessions').select().eq('session_id', sessionId).single();
    if (session) return; // already logged

    const startIso = oldState.channel?.joined_at?.toISOString() ?? new Date().toISOString();
    const endIso = newState.channel?.joined_at?.toISOString() ?? new Date().toISOString();
    const durationSec = Math.floor((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000);

    const { data: profileData } = await supabase
      .from('profiles')
      .select('member_name')
      .eq('id', profile.id)
      .single();

    const channelName = newState.channel?.name ?? 'Unknown Channel';
    const memberName = profileData?.member_name ?? newState.member.user.tag;

    // 1. Stage 1 embed
    const embed1 = new EmbedBuilder()
      .setTitle('Voice leave')
      .setDescription(`**${memberName}** left **${channelName}**\nTracked · **${formatDurationSec(durationSec)}** · closing session...\n\n#attendance-logs`)
      .setColor(0x3498db)
      .setFooter({ text: 'Stage 1 · Session' });

    // 2. Stage 2 embed - sign payload
    const payload = `${sessionId}|${profile.id}|${newState.channel.id}|${startIso}|${endIso}|${durationSec}`;
    const signature = signPayload(canonicalString({ session_id: sessionId, user_id: profile.id, channel_id: newState.channel.id, start_iso: startIso, end_iso: endIso, duration_sec: durationSec }), getPrivateKey());

    const embed2 = new EmbedBuilder()
      .setTitle('Session complete')
      .setDescription(`Member · **${memberName}**\nChannel · **${channelName}**\nDuration · **${formatDurationSec(durationSec)}**\n\`${sessionId}|${profile.id}|${newState.channel.id}|${startIso}|${endIso}|${durationSec}\``)
      .setColor(0x2ecc71)
      .setFooter({ text: 'Signed · Ed25519' });

    // 3. Stage 3 embed - public verification
    const embed3 = new EmbedBuilder()
      .setTitle('Challenge this record')
      .setDescription(`Anyone with the session UUID can check the signature — no admin required.\n[Verify · yourdomain.com/verifier?id=${sessionId}](${process.env.VERIFIER_URL || 'https://yourdomain.com/verifier?id=' + sessionId})`)
      .setColor(0xe67e22)
      .setFooter({ text: 'Public verifier' });

    // Send 3-stage sequence
    const channel = newState.channel?.id ? await this.client.channels.fetch(newState.channel.id) : null;
    if (channel) {
      await channel.send({ embeds: [embed1, embed2, embed3] });
    }
  }

  private async fetchProfile(discordUserId: string): Promise<Profile | null> {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('discord_user_id', discordUserId)
      .single();
    return data ?? null;
  }

  private async fetchGuildConfig(guildId: string): Promise<Database['public']['Tables']['guild_configs']['Row'] | null> {
    const { data } = await supabase.from('guild_configs').select('*').eq('guild_id', guildId).single();
    return data ?? null;
  }

  private async updateDutyPanelCounters(guildId: string) {
    // In production: cache in Redis or similar; here we just ensure panel exists
    // This would be handled by a separate duty panel bot or webhook
  }

  private async handleDutyStatus(interaction: ButtonInteraction) {
    // This is now in duty-handlers.ts - keep this file focused on voice
  }

  private async handleDutyCheckIn(interaction: ButtonInteraction) {
    // same
  }

  private async handleDutyBreakToggle(interaction: ButtonInteraction) {
    // same
  }

  private async handleDutyCheckOut(interaction: ButtonInteraction) {
    // same
  }

  // Export voice listener for main bot
  getVoiceListener() {
    return this.client.on('voiceStateUpdate', async (oldState, newState) => {
      if (!newState.member) return;

      const profile = await this.fetchProfile(newState.member.user.id);
      if (!profile) return;

      const guildConfig = await this.fetchGuildConfig(newState.guildId!);
      if (!guildConfig || !guildConfig.tracked_voice_channel_ids?.includes(newState.channelId)) return;

      if (oldState.channelId && newState.channelId) {
        await this.handleVoiceLeave(oldState, newState, profile);
      }
    });
  }
}

// ---- helpers ----

function formatDurationSec(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function getPrivateKey(): string {
  // In production: load from secure env var or secret manager
  return process.env.ED25519_PRIVATE_KEY || 'invalid-test-key';
}

// Helper to fetch profile (same as above)