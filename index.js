require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder
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
if (!token) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

// ---- Simple in-memory queues per guild ----
/**
 * queue = {
 *   textChannelId,
 *   voiceChannelId,
 *   connection,
 *   player,
 *   tracks: [{ title, url, requestedBy }]
 *   playing: boolean
 *   now: track|null
 * }
 */
const queues = new Map();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("play")
      .setDescription("Play a song")
      .addStringOption(opt =>
        opt.setName("query").setDescription("Song name or URL").setRequired(true)
      ),
    new SlashCommandBuilder().setName("skip").setDescription("Skip song"),
    new SlashCommandBuilder().setName("stop").setDescription("Stop bot"),
    new SlashCommandBuilder().setName("queue").setDescription("Show queue"),
    new SlashCommandBuilder().setName("pause").setDescription("Pause"),
    new SlashCommandBuilder().setName("resume").setDescription("Resume"),
    new SlashCommandBuilder().setName("now").setDescription("Now playing")
  ].map(c => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

  await rest.put(
    Routes.applicationCommands(process.env.CLIENT_ID),
    { body: commands }
  );

  console.log("Slash commands registered.");
}

client.once("ready", async () => {
  await registerCommands();
});
client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "play") {
      await handlePlay(interaction);
    } else if (interaction.commandName === "skip") {
      await handleSkip(interaction);
    } else if (interaction.commandName === "stop") {
      await handleStop(interaction);
    } else if (interaction.commandName === "queue") {
      await handleQueue(interaction);
    } else if (interaction.commandName === "now") {
      await handleNow(interaction);
    } else if (interaction.commandName === "pause") {
      await handlePause(interaction);
    } else if (interaction.commandName === "resume") {
      await handleResume(interaction);
    }
  } catch (err) {
    console.error(err);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: "صار خطأ 😅 جرّب مرة ثانية.", ephemeral: true });
    } else {
      await interaction.reply({ content: "صار خطأ 😅 جرّب مرة ثانية.", ephemeral: true });
    }
  }
});

async function handlePlay(interaction) {
  const query = interaction.options.getString("query", true);

  const member = interaction.member;
  const voiceChannel = member?.voice?.channel;

  if (!voiceChannel) {
    return interaction.reply({ content: "لازم تكون داخل روم فويس أول.", ephemeral: true });
  }

  await interaction.deferReply();

  const track = await resolveTrack(query, interaction.user.tag);
  if (!track) {
    return interaction.editReply("ما قدرت ألقى شي من هالبحث/الرابط.");
  }

  const guildId = interaction.guildId;
  let q = queues.get(guildId);

  if (!q) {
    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause
      }
    });

    q = {
      textChannelId: interaction.channelId,
      voiceChannelId: voiceChannel.id,
      connection: null,
      player,
      tracks: [],
      playing: false,
      now: null
    };

    queues.set(guildId, q);

    // Player events
    player.on(AudioPlayerStatus.Idle, async () => {
      q.now = null;
      q.playing = false;
      await playNext(guildId).catch(console.error);
    });

    player.on("error", (e) => {
      console.error("Audio player error:", e);
      q.now = null;
      q.playing = false;
      playNext(guildId).catch(console.error);
    });
  }

  // If user is in different voice channel than queue
  if (q.voiceChannelId !== voiceChannel.id && q.playing) {
    return interaction.editReply("أنا قاعد أشغّل بروم ثاني. وقفني بـ /stop وبعدين شغّل هنا.");
  }

  q.voiceChannelId = voiceChannel.id;
  q.textChannelId = interaction.channelId;

  q.tracks.push(track);

  const embed = new EmbedBuilder()
    .setTitle("✅ انضاف للكيو")
    .setDescription(`[${track.title}](${track.url})`)
    .addFields({ name: "Requested by", value: track.requestedBy, inline: true })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });

  if (!q.playing) {
    await ensureConnection(interaction, q, voiceChannel);
    await playNext(guildId);
  }
}

async function handleSkip(interaction) {
  const q = queues.get(interaction.guildId);
  if (!q || !q.player) {
    return interaction.reply({ content: "ماكو شي شغّال.", ephemeral: true });
  }
  q.player.stop(true);
  return interaction.reply("⏭️ تم التخطي.");
}

async function handleStop(interaction) {
  const q = queues.get(interaction.guildId);
  if (!q) return interaction.reply({ content: "ماكو شي شغّال.", ephemeral: true });

  q.tracks = [];
  q.now = null;
  q.playing = false;

  try { q.player?.stop(true); } catch {}
  try { q.connection?.destroy(); } catch {}

  queues.delete(interaction.guildId);
  return interaction.reply("🛑 تم الإيقاف والخروج من الفويس.");
}

async function handleQueue(interaction) {
  const q = queues.get(interaction.guildId);
  if (!q) return interaction.reply({ content: "الكيو فاضي.", ephemeral: true });

  const now = q.now ? `🎶 الحين: [${q.now.title}](${q.now.url})\n\n` : "🎶 الحين: ماكو\n\n";
  const list = q.tracks.length
    ? q.tracks.slice(0, 10).map((t, i) => `${i + 1}) [${t.title}](${t.url}) — ${t.requestedBy}`).join("\n")
    : "—";

  const embed = new EmbedBuilder()
    .setTitle("📃 Queue")
    .setDescription(now + "التالي:\n" + list)
    .setFooter({ text: q.tracks.length > 10 ? `وفي بعد ${q.tracks.length - 10} ...` : " " });

  return interaction.reply({ embeds: [embed], ephemeral: false });
}

async function handleNow(interaction) {
  const q = queues.get(interaction.guildId);
  if (!q || !q.now) return interaction.reply({ content: "ماكو شي شغّال الحين.", ephemeral: true });

  const embed = new EmbedBuilder()
    .setTitle("🎧 Now Playing")
    .setDescription(`[${q.now.title}](${q.now.url})`)
    .addFields({ name: "Requested by", value: q.now.requestedBy, inline: true })
    .setTimestamp();

  return interaction.reply({ embeds: [embed] });
}

async function handlePause(interaction) {
  const q = queues.get(interaction.guildId);
  if (!q) return interaction.reply({ content: "ماكو شي شغّال.", ephemeral: true });

  const ok = q.player.pause(true);
  return interaction.reply(ok ? "⏸️ تم الإيقاف المؤقت." : "ما قدرت أوقف مؤقت.");
}

async function handleResume(interaction) {
  const q = queues.get(interaction.guildId);
  if (!q) return interaction.reply({ content: "ماكو شي شغّال.", ephemeral: true });

  const ok = q.player.unpause();
  return interaction.reply(ok ? "▶️ تم الاستكمال." : "ما قدرت أكمل.");
}

async function ensureConnection(interaction, q, voiceChannel) {
  if (q.connection && q.connection.state.status !== VoiceConnectionStatus.Destroyed) return;

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: interaction.guildId,
    adapterCreator: interaction.guild.voiceAdapterCreator,
    selfDeaf: true
  });

  q.connection = connection;

  connection.on("error", console.error);

  // Wait until Ready
  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

  connection.subscribe(q.player);
}

async function playNext(guildId) {
  const q = queues.get(guildId);
  if (!q) return;

  // If no more tracks, disconnect
  if (!q.tracks.length) {
    q.playing = false;
    q.now = null;
    try { q.connection?.destroy(); } catch {}
    queues.delete(guildId);
    return;
  }

  const next = q.tracks.shift();
  q.now = next;
  q.playing = true;

  // Create stream
  const stream = await play.stream(next.url, { quality: 2 }); // 0..2 (higher = better)
  const resource = createAudioResource(stream.stream, {
    inputType: stream.type
  });

  q.player.play(resource);

  // Optional: announce in channel (best-effort)
  try {
    const channel = await client.channels.fetch(q.textChannelId);
    if (channel && channel.isTextBased()) {
      const embed = new EmbedBuilder()
        .setTitle("🎶 شغّال الحين")
        .setDescription(`[${next.title}](${next.url})`)
        .addFields({ name: "Requested by", value: next.requestedBy, inline: true })
        .setTimestamp();
      await channel.send({ embeds: [embed] });
    }
  } catch {}
}

async function resolveTrack(query, requestedBy) {
  try {
    const isUrl = /^https?:\/\//i.test(query);

    if (isUrl) {
      const info = await play.video_basic_info(query);
      if (!info?.video_details?.url) return null;
      return {
        title: info.video_details.title ?? "Unknown",
        url: info.video_details.url,
        requestedBy
      };
    } else {
      const results = await play.search(query, { limit: 1 });
      if (!results?.length) return null;
      return {
        title: results[0].title ?? "Unknown",
        url: results[0].url,
        requestedBy
      };
    }
  } catch (e) {
    console.error("resolveTrack error:", e);
    return null;
  }
}

client.login(token);
