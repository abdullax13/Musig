require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId || !guildId) {
  console.error("Missing env vars. Set DISCORD_TOKEN, CLIENT_ID, GUILD_ID");
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("شغّل أغنية/رابط يوتيوب أو بحث")
    .addStringOption(opt =>
      opt.setName("query")
        .setDescription("رابط يوتيوب أو كلمات بحث")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("تخطّي التراك الحالي"),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("إيقاف وتشغيل وتنظيف الكيو والخروج"),

  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("عرض الكيو"),

  new SlashCommandBuilder()
    .setName("now")
    .setDescription("شنو قاعد يشتغل الحين"),

  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("توقيف مؤقت"),

  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("تكملة التشغيل")
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(token);

(async () => {
  try {
    console.log("Registering guild slash commands...");
    await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: commands }
    );
    console.log("Done ✅");
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
