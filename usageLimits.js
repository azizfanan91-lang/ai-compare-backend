// حدود الاستعمال فـ مكان واحد (كيقراوها chatRoutes و imageRoutes و paymentRoutes)
function positiveIntegerEnv(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

module.exports = {
  TRIAL_DAYS: positiveIntegerEnv('TRIAL_DAYS', 7),
  FREE_CHAT_DAILY_LIMIT: positiveIntegerEnv('FREE_CHAT_DAILY_LIMIT', 10),
  FREE_IMAGE_DAILY_LIMIT: positiveIntegerEnv('FREE_IMAGE_DAILY_LIMIT', 3),
  PREMIUM_IMAGE_DAILY_LIMIT: positiveIntegerEnv('PREMIUM_IMAGE_DAILY_LIMIT', 100),
  // سقف حماية للمشترك (ماشي حد تجاري)
  PREMIUM_CHAT_HARD_LIMIT: positiveIntegerEnv('PREMIUM_CHAT_HARD_LIMIT', 1000)
};
