import { Client, GatewayIntentBits, Partials, REST, Routes } from 'discord.js';
import { supabase } from '../lib/supabase';
import { commands, handleSlashCommand, handleAutocomplete } from '../slashcommands';
import { AttendanceBotClient } from './voice-listener';
import { createSign, createVerify, generateKeyPairSync } from 'node:crypto';

const discordToken = process.env.DISCORD_BOT_TOKEN!;
const clientId = process.env.DISCORD_CLIENT_ID!;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],
  partials: [Partials.User, Partials.GuildMember],
});

client.once('ready', async () => {
  console.log(`AttendanceBot ready as ${client.user?.tag}`);
  const rest = new REST({ version: '10' }).setToken(discordToken);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log('Slash commands registered.');
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    try {
      await handleSlashCommand(interaction);
    } catch (err) {
      console.error('Slash command error:', err);
      await interaction.reply({ content: '⚠️ Internal error.', ephemeral: true }).catch(() => {});
    }
  } else if (interaction.isAutocomplete()) {
    try {
      await handleAutocomplete(interaction);
    } catch (err) {
      console.error('Autocomplete error:', err);
    }
  } else if (interaction.isButton()) {
    await handleButton(interaction);
  }
});

async function handleButton(interaction: any) {
  const [action, ...args] = interaction.customId.split(':');
  if (action === 'duty') {
    const handler = new AttendanceBotClient(client as any);
    // Dispatch to duty handlers
    const dutyHandlers = await import('./duty-handlers');
    switch (interaction.customId) {
      case 'duty:status':
        return dutyHandlers.handleDutyStatus(interaction);
      case 'duty:checkin':
        return dutyHandlers.handleDutyCheckIn(interaction);
      case 'duty:break':
        return dutyHandlers.handleDutyBreakToggle(interaction);
      case 'duty:checkout':
        return dutyHandlers.handleDutyCheckOut(interaction);
      default:
        return interaction.reply({ content: 'Unknown action.', ephemeral: true });
    }
  }
}

client.login(discordToken).catch((err) => console.error('Discord login failed:', err));

export { client, supabase };
export function createEd25519Keys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const publicKeyPem = publicKey.toString();
  const privateKeyPem = privateKey.toString();
  const verifier = createVerify('sha256');
  verifier.update('');
  const signer = createSign('sha256');
  signer.update('');
  return { publicKeyPem, privateKeyPem, signer, verifier };
}
