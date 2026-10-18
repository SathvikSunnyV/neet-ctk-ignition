// sms.js — OTP delivery by SMS (Twilio REST API) plus phone-number
// normalisation. Same behaviour as Connectomic Medical Academy's sms.js:
// if Twilio isn't configured (or the send fails) the OTP is printed to the
// server console instead, so the app stays usable in development.
//
// Uses Node's built-in fetch (Node >= 18) so no new npm dependency is needed.

const hasTwilio = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);

function normalizePhone(phone) {
    if (!phone) return null;
    let cleaned = String(phone).trim().replace(/[\s\-().]/g, '');
    if (!cleaned) return null;
    if (cleaned.startsWith('+')) return cleaned;          // already E.164, e.g. +919876543210
    cleaned = cleaned.replace(/^0+/, '');                 // drop a leading trunk 0
    if (/^\d{10}$/.test(cleaned)) return `+91${cleaned}`; // bare 10-digit -> Indian mobile
    if (/^\d{11,15}$/.test(cleaned)) return `+${cleaned}`;// country code present, '+' missing
    return cleaned;
}

async function sendOtpSms(toPhone, otp, purpose = 'verify your account') {
    const body = `Your CTK Bridge Course OTP to ${purpose} is ${otp}. It is valid for 10 minutes. Do not share it with anyone.`;

    if (hasTwilio) {
        try {
            const sid = process.env.TWILIO_ACCOUNT_SID;
            const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
            const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
                method: 'POST',
                headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ To: toPhone, From: process.env.TWILIO_PHONE_NUMBER, Body: body }).toString()
            });
            if (!resp.ok) throw new Error(`Twilio responded ${resp.status}: ${await resp.text()}`);
            return { delivered: true };
        } catch (err) {
            console.error('Twilio SMS error:', err?.message || err);
            console.log(`\n📱  [TWILIO SEND FAILED — falling back] OTP for ${toPhone}: ${otp}\n`);
            return { delivered: false };
        }
    }

    console.log(`\n📱  [DEV MODE — no SMS provider configured] OTP for ${toPhone}: ${otp}\n`);
    return { delivered: false };
}

module.exports = { sendOtpSms, normalizePhone, hasTwilio };
