import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export const DUTY_PANEL_COLOR = 0xffd166; // amber

export function buildDutyPanelEmbed(working: number, onBreak: number, lastUpdate: number): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('🕙 Clocky Duty')
    .setDescription(
      `**${working} working · ${onBreak} on break**\n\nData updated <t:${lastUpdate}:R> · UTC\n\nUse these controls for your own timer. Replies are private.`,
    )
    .setColor(DUTY_PANEL_COLOR);
}

export function buildDutyPanelComponents(): ActionRowBuilder[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('duty:status').setEmoji('👤').setStyle(ButtonStyle.Primary). Label('My status'),
    new ButtonBuilder().setCustomId('duty:checkin').setEmoji('▶️').setStyle(ButtonStyle.Success). Label('Check in'),
    new ButtonBuilder().setCustomId('duty:break').setEmoji('☕').setStyle(ButtonStyle.Secondary). Label('Break / resume'),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('duty:checkout').setEmoji('⏹️').setStyle(ButtonStyle.Secondary). Label('Check out'),
  );
  return [row1, row2];
}

export function buildStatusEmbed(status: string, color: number, lines: string[]): EmbedBuilder {
  return new EmbedBuilder()
    .setDescription(lines.join('\n'))
    .setColor(color);
}

export function formatDurationMs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatDurationSec(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}