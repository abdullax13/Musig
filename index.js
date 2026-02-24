require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");

const sodium = require("libsodium-wrappers");

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} = require("@discordjs/voice");

const ytdl = require("@distube/ytdl-core");
const yts = require("yt-search");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId || !guildId) {
  console.error("Missing env vars. Required: DISCORD_TOKEN, CLIENT_ID, GUILD_ID");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

// guildId -> { connection, player, nowUrl }
const sessions = new Map();

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("play")
      .setDescription("تشغيل أغنية (بحث أو رابط يوتيوب)")
      .addStringOption(opt =>
        opt.setName("query")
          .setDescription("اسم الأغنية أو رابط")
          .setRequired(true)
      ),
    new SlashCommandBuilder().setName("pause").setDescription("إيقاف مؤقت"),
    new SlashCommandBuilder().setName("resume").setDescription("تكملة"),
    new SlashCommandBuilder().setName("stop").setDescription("إيقاف وخروج من الفويس")
  ].map(c => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(token);

  // Guild commands = تظهر فورًا وتستبدل القديمة داخل السيرفر
  await rest.put(
    Routes.applicationGuildCommands(clientId, guildId),
    { body: commands }
  );

  console.log("Commands registered (guild).");
}

function withTimeout(promise, ms, label = "operation") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
    )
  ]);
}

async function resolveYouTubeUrl(query) {
  if (ytdl.validateURL(query)) return query;

  const result = await withTimeout(yts(query), 12_000, "search");
  if (!result?.videos?.length) return null;
  return result.videos[0].url;
}

async function getOpusStream(url) {
  // نجيب info ونختار WebM/Opus عشان ما نحتاج FFmpeg
  const info = await withTimeout(ytdl.getInfo(url), 15_000, "getInfo");

  const format = ytdl.chooseFormat(info.formats, {
    quality: "highestaudio",
    filter: (f) =>
      f.container === "webm" &&
      typeof f.codecs === "string" &&
      f.codecs.includes("opus") &&
      f.hasAudio
  });

  if (!format || !format.url) {
    throw new Error("No opus/webm format available (YouTube restriction or parsing failure).");
  }

  const stream = ytdl.downloadFromInfo(info, {
    format,
    highWaterMark: 1 << 25
  });

  return stream;
}

function getSession(guildId) {
  let s = sessions.get(guildId);
  if (!s) {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
    });

    player.on("error", (e) => {
      console.error("Player error:", e);
    });

    s = { connection: null, player, nowUrl: null };
    sessions.set(guildId, s);
  }
  return s;
}

async function connectToVoice(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) return null;

  const s = getSession(interaction.guildId);

  if (!s.connection || s.connection.state.status === VoiceConnectionStatus.Destroyed) {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: interaction.guild.id,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: true
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    connection.subscribe(s.player);

    s.connection = connection;

    // لو فصل، ننظف
    connection.on("error", (e) => console.error("Voice connection error:", e));
  }

  return s;
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // مهم: نخلي libsodium جاهز قبل أي voice encryption
  await sodium.ready;

  await registerCommands();
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "play") {
      const voiceChannel = interaction.member?.voice?.channel;
      if (!voiceChannel) {
        return interaction.reply({ content: "ادخل روم فويس أول.", ephemeral: true });
      }

      await interaction.deferReply();

      const query = interaction.options.getString("query", true);
      const url = await resolveYouTubeUrl(query);

      if (!url) {
        return interaction.editReply("ما حصلت نتيجة لهالبحث.");
      }

      const s = await connectToVoice(interaction);
      if (!s) return interaction.editReply("ادخل روم فويس أول.");

      const stream = await getOpusStream(url);

      const resource = createAudioResource(stream, {
        inputType: StreamType.WebmOpus
      });

      s.nowUrl = url;
      s.player.play(resource);

      s.player.once(AudioPlayerStatus.Idle, () => {
        try { s.connection?.destroy(); } catch {}
        sessions.delete(interaction.guildId);
      });

      return interaction.editReply("🎶 شغّلت الصوت ودخلت الفويس.");
    }

    if (interaction.commandName === "pause") {
      const s = sessions.get(interaction.guildId);
      if (!s) return interaction.reply({ content: "ماكو شي شغّال.", ephemeral: true });
      s.player.pause(true);
      return interaction.reply("⏸️ تم الإيقاف المؤقت.");
    }

    if (interaction.commandName === "resume") {
      const s = sessions.get(interaction.guildId);
      if (!s) return interaction.reply({ content: "ماكو شي شغّال.", ephemeral: true });
      s.player.unpause();
      return interaction.reply("▶️ تم الاستكمال.");
    }

    if (interaction.commandName === "stop") {
      const s = sessions.get(interaction.guildId);
      if (!s) return interaction.reply({ content: "ماكو شي شغّال.", ephemeral: true });

      try { s.player.stop(true); } catch {}
      try { s.connection?.destroy(); } catch {}
      sessions.delete(interaction.guildId);

      return interaction.reply("🛑 تم الإيقاف والخروج من الفويس.");
    }
  } catch (e) {
    console.error("Command error:", e);

    // مهم عشان ما يصير “application did not respond”
    if (interaction.deferred || interaction.replied) {
      return interaction.followUp({ content: `صار خطأ: ${e.message}`, ephemeral: true });
    }
    return interaction.reply({ content: `صار خطأ: ${e.message}`, ephemeral: true });
  }
});

client.login(token);
