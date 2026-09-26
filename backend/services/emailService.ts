import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { isDevEnv } from '../utils/env.js';

dotenv.config();

const transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

export const sendResetPasswordEmail = async (email: string, token: string) => {
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

    // The link carries the reset token (a password-equivalent), so only
    // surface it locally. Never in prod logs or on the container disk.
    if (isDevEnv()) {
        console.log(`[Email Service] Reset Link: ${resetUrl}`);
        try {
            const logPath = path.join(process.cwd(), 'reset_link.txt');
            fs.writeFileSync(logPath, resetUrl);
            console.log(`[Email Service] Reset link written to ${logPath}`);
        } catch (e) {
            console.error("Failed to write reset link to file:", e);
        }
    }

    try {
        if (process.env.EMAIL_PASS) {
             const info = await transporter.sendMail(mailOptions);
             console.log(`[Email Service] Email sent: ${info.response}`);
             return info;
        } else {
             console.warn('[Email Service] EMAIL_PASS not set. Skipping actual email send.');
             return { response: 'Mock email sent' };
        }
       
    } catch (error) {
        console.error('Error sending email:', error);
        throw error;
    }
};

export const sendVerificationEmail = async (email: string, token: string) => {
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

    // Same as the reset link: the token must not reach prod logs or disk.
    if (isDevEnv()) {
        console.log(`[Email Service] Verify Link: ${verifyUrl}`);
        try {
            const logPath = path.join(process.cwd(), 'verify_link.txt');
            fs.writeFileSync(logPath, verifyUrl);
            console.log(`[Email Service] Verify link written to ${logPath}`);
        } catch (e) {
            console.error("Failed to write verify link to file:", e);
        }
    }

    try {
        if (process.env.EMAIL_PASS) {
             const info = await transporter.sendMail(mailOptions);
             console.log(`[Email Service] Email sent: ${info.response}`);
             return info;
        } else {
             console.warn('[Email Service] EMAIL_PASS not set. Skipping actual email send.');
             return { response: 'Mock email sent' };
        }
       
    } catch (error) {
        console.error('Error sending verification email:', error);
        throw error;
    }
};
