// Simple branded HTML email wrapper - matches the site's header style
// (dark green bar, "Trade" in white + "Link" in light mint).
function wrapBranded(bodyHtml) {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;">
    <div style="background:#123f2e;padding:22px 28px;">
      <span style="font-size:22px;font-weight:600;letter-spacing:-0.3px;color:#ffffff;">Trade<span style="color:#a7d8c1;">Linkd</span></span>
    </div>
    <div style="background:#ffffff;padding:28px;border:1px solid #e6e4de;border-top:none;color:#1c1c1a;font-size:14px;line-height:1.6;">
      ${bodyHtml}
    </div>
  </div>`;
}

function welcomeEmail(name) {
  const html = wrapBranded(`
    <p style="margin:0 0 12px;">Hi ${escapeHtml(name)},</p>
    <p style="margin:0 0 12px;">Thanks for joining TradeLinkd! Your account is all set up and ready to go.</p>
    <p style="margin:0;">We're glad to have you here.</p>
  `);
  const text = `Hi ${name},\n\nThanks for joining TradeLinkd! Your account is all set up and ready to go.\n\nWe're glad to have you here.`;
  return { subject: 'Welcome to TradeLinkd', html, text };
}

function messageNotificationEmail(senderName, body) {
  const html = wrapBranded(`
    <p style="margin:0 0 12px;"><strong>${escapeHtml(senderName)}</strong> sent you a message on TradeLinkd:</p>
    <p style="margin:0 0 16px;padding:12px 14px;background:#e5f0ea;border-radius:10px;color:#123f2e;">${escapeHtml(body)}</p>
    <p style="margin:0;color:#6b6a66;font-size:13px;">Log in to TradeLinkd to reply.</p>
  `);
  const text = `${senderName} sent you a message on TradeLinkd:\n\n"${body}"\n\nLog in to TradeLinkd to reply.`;
  return { subject: `New message on TradeLinkd from ${senderName}`, html, text };
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function passwordResetEmail(name, resetUrl) {
  const html = wrapBranded(`
    <p style="margin:0 0 12px;">Hi ${escapeHtml(name)},</p>
    <p style="margin:0 0 16px;">We got a request to reset your TradeLinkd password. Click below to choose a new one — this link works for 1 hour.</p>
    <p style="margin:0 0 16px;"><a href="${resetUrl}" style="display:inline-block;background:#1d5f45;color:#ffffff;padding:10px 20px;border-radius:999px;text-decoration:none;font-weight:600;">Reset Password</a></p>
    <p style="margin:0;color:#6b6a66;font-size:13px;">If you didn't request this, you can safely ignore this email — your password won't change.</p>
  `);
  const text = `Hi ${name},\n\nWe got a request to reset your TradeLinkd password. Use this link within the next hour:\n${resetUrl}\n\nIf you didn't request this, you can ignore this email.`;
  return { subject: 'Reset your TradeLinkd password', html, text };
}

module.exports = { welcomeEmail, messageNotificationEmail, passwordResetEmail };
