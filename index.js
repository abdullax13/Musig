require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  entersState
} = require("@discordjs/voice");

const play = require("play-dl");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;

if (!token || !clientId) {
  console.error("Missing DISCORD_TOKEN or CLIENT_ID in Railway Variables");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const queues = new Map();


// ================= REGISTER SLASH COMMANDS =================
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("play")
      .setDescription("Play a song")
      .addStringOption(opt =>
        opt.setName("query")
          .setDescription("Song name or URL")
          .setRequired(true)
      ),

    new SlashCommandBuilder().setName("skip").setDescription("Skip song"),
    new SlashCommandBuilder().setName("stop").setDescription("Stop bot"),
    new SlashCommandBuilder().setName("queue").setDescription("Show queue"),
    new SlashCommandBuilder().setName("pause").setDescription("Pause"),
    new SlashCommandBuilder().setName("resume").setDescription("Resume"),
    new SlashCommandBuilder().setName("now").setDescription("Now playing")
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: "10" }).setToken(token);

  await rest.put(
    Routes.applicationCommands(clientId),
    { body: commands }
  );

  console.log("Slash commands registered globally.");
}
// ============================================================


client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});


// ================= INTERACTIONS =================
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "play") {
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
      return interaction.reply({ content: "ادخل روم فويس أول.", ephemeral: true });
    }

    await interaction.deferReply();

    const query = interaction.options.getString("query");

    const result = await play.search(query, { limit: 1 });
    if (!result.length) {
      return interaction.editReply("ما حصلت نتيجة.");
    }

    const song = result[0];

    const stream = await play.stream(song.url);

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: interaction.guild.id,
      adapterCreator: interaction.guild.voiceAdapterCreator
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20000);

    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause
      }
    });

    const resource = createAudioResource(stream.stream, {
      inputType: stream.type
    });

    player.play(resource);
    connection.subscribe(player);

    interaction.editReply(`🎶 Now Playing: **${song.title}**`);
  }

  if (interaction.commandName === "skip") {
    interaction.reply("حالياً النسخة المبسطة ما فيها كيو.");
  }

  if (interaction.commandName === "stop") {
    const connection = joinVoiceChannel({
      channelId: interaction.member.voice.channel?.id,
      guildId: interaction.guild.id,
      adapterCreator: interaction.guild.voiceAdapterCreator
    });
    connection.destroy();
    interaction.reply("تم الإيقاف.");
  }
});
// =================================================

client.login(token);
