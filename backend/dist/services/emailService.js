import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
dotenv.config();
const transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});
export const sendResetPasswordEmail = async (email, token) => {
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: email,
        subject: 'Password Reset Request',
        html: `
            <p>You requested a password reset.</p>
            <p>Click this link to reset your password:</p>
            <a href="${resetUrl}">${resetUrl}</a>
            <p>This link expires in 1 hour.</p>
        `
    };
    console.log(`[Email Service] Sending reset password email to ${email}`);
    console.log(`[Email Service] Reset Link: ${resetUrl}`); // Log for dev/testing
    // HACK: Log to file for testing/demo purposes
    try {
        const logPath = path.join(process.cwd(), 'reset_link.txt');
        fs.writeFileSync(logPath, resetUrl);
        console.log(`[Email Service] Reset link written to ${logPath}`);
    }
    catch (e) {
        console.error("Failed to write reset link to file:", e);
    }
    try {
        if (process.env.EMAIL_PASS) {
            const info = await transporter.sendMail(mailOptions);
            console.log(`[Email Service] Email sent: ${info.response}`);
            return info;
        }
        else {
            console.log('[Email Service] No password provided. Skipping actual email send. Check console for link.');
            return { response: 'Mock email sent' };
        }
    }
    catch (error) {
        console.error('Error sending email:', error);
        throw error;
    }
};
export const sendVerificationEmail = async (email, token) => {
    const verifyUrl = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: email,
        subject: 'Email Verification',
        html: `
            <p>Welcome!</p>
            <p>Click this link to verify your email address:</p>
            <a href="${verifyUrl}">${verifyUrl}</a>
            <p>This link expires in 24 hours.</p>
        `
    };
    console.log(`[Email Service] Sending verification email to ${email}`);
    console.log(`[Email Service] Verify Link: ${verifyUrl}`); // Log for dev/testing
    // HACK: Log to file for testing/demo purposes
    try {
        const logPath = path.join(process.cwd(), 'verify_link.txt');
        fs.writeFileSync(logPath, verifyUrl);
        console.log(`[Email Service] Verify link written to ${logPath}`);
    }
    catch (e) {
        console.error("Failed to write verify link to file:", e);
    }
    try {
        if (process.env.EMAIL_PASS) {
            const info = await transporter.sendMail(mailOptions);
            console.log(`[Email Service] Email sent: ${info.response}`);
            return info;
        }
        else {
            console.log('[Email Service] No password provided. Skipping actual email send. Check console for link.');
            return { response: 'Mock email sent' };
        }
    }
    catch (error) {
        console.error('Error sending verification email:', error);
        throw error;
    }
};
