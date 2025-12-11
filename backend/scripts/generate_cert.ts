import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import util from "util";

const execPromise = util.promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OPENSSL_PATH = "C:\\Program Files\\Git\\usr\\bin\\openssl.exe";
const OUTPUT_DIR = path.resolve(__dirname, "../certs");
const KEY_FILE = path.join(OUTPUT_DIR, "server.key");
const CRT_FILE = path.join(OUTPUT_DIR, "server.crt");

const checkOpenSSL = async (): Promise<string> => {
    try {
        await execPromise("openssl version");
        return "openssl";
    } catch (error) {
        if (fs.existsSync(OPENSSL_PATH)) {
            return `"${OPENSSL_PATH}"`;
        }
        throw new Error("OpenSSL not found in PATH or at default location.");
    }
};

const generateCert = async () => {
    try {
        if (!fs.existsSync(OUTPUT_DIR)) {
            console.log(`Creating directory: ${OUTPUT_DIR}`);
            fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        }

        const opensslCmd = await checkOpenSSL();
        console.log(`Using OpenSSL command: ${opensslCmd}`);

        const command = `${opensslCmd} req -newkey rsa:2048 -nodes -keyout "${KEY_FILE}" -x509 -days 365 -out "${CRT_FILE}" -subj "/C=US/ST=State/L=City/O=Organization/OU=Unit/CN=localhost"`;

        console.log("Generating certificate...");
        const { stdout, stderr } = await execPromise(command);

        if (stderr) {
            // OpenSSL writes progress to stderr, so we log it but don't treat it as a fatal error unless the command failed
            console.log("OpenSSL Output:", stderr);
        }

        if (fs.existsSync(KEY_FILE) && fs.existsSync(CRT_FILE)) {
            console.log("✅ Certificate generation successful!");
            console.log(`Private Key: ${KEY_FILE}`);
            console.log(`Certificate: ${CRT_FILE}`);
        } else {
            console.error("❌ Generation appeared to succeed, but files were not found.");
            process.exit(1);
        }

    } catch (error) {
        console.error("❌ Error generating certificate:", error);
        process.exit(1);
    }
};

generateCert();
