const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const axios = require('axios');
require("dotenv").config();

/**
 * @function sendTelegramMessage
 * @description Mengirim pesan notifikasi ke Telegram.
 * @param {string} message - Pesan yang akan dikirim.
 */
async function sendTelegramMessage(message) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    try {
        await axios.post(url, {
            chat_id: chatId,
            text: message
        });
        console.log("✅ Notifikasi Telegram terkirim.");
    } catch (err) {
        console.error("⚠️ Gagal kirim ke Telegram:", err.message);
    }
}

/**
 * @function getPiWalletAddressFromSeed
 * @description Mengambil public dan secret key dari mnemonic.
 * @param {string} mnemonic - Frasa mnemonik dompet.
 * @returns {object} Objek berisi publicKey dan secretKey.
 * @throws {Error} Jika mnemonik tidak valid.
 */
async function getPiWalletAddressFromSeed(mnemonic) {
    if (!bip39.validateMnemonic(mnemonic)) {
        throw new Error("Invalid mnemonic");
    }
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const derivationPath = "m/44'/314159'/0'"; // Jalur derivasi untuk Pi Network
    const { key } = ed25519.derivePath(derivationPath, seed.toString('hex'));
    const keypair = StellarSdk.Keypair.fromRawEd25519Seed(key);

    return {
        publicKey: keypair.publicKey(),
        secretKey: keypair.secret()
    };
}

/**
 * @function claimAndSend
 * @description Fungsi utama untuk mengklaim saldo yang dapat diklaim dan mentransfernya dalam batch.
 * Ini akan mengklaim hingga 25 saldo yang dapat diklaim dan mengirimkannya
 * dalam satu transaksi tunggal.
 */
async function claimAndSend() {
    const mnemonic = process.env.MNEMONIC;
    const receiver = process.env.RECEIVER_ADDRESS;

    if (!mnemonic || !receiver) {
        console.error("❌ Pastikan MNEMONIC dan RECEIVER_ADDRESS diatur di file .env Anda.");
        return;
    }

    try {
        // Mendapatkan public dan secret key dari mnemonik
        const { publicKey, secretKey } = await getPiWalletAddressFromSeed(mnemonic);
        // Inisialisasi server Stellar untuk Pi Network
        const server = new StellarSdk.Server('https://api.mainnet.minepi.com');
        // Membuat keypair dari secret key untuk penandatanganan transaksi
        const keypair = StellarSdk.Keypair.fromSecret(secretKey);

        console.log("🔑 Sender Public Key:", publicKey);
        console.log("🎯 Receiver Address:", receiver);

        // Memuat detail akun pengirim
        const account = await server.loadAccount(publicKey);
        console.log(`✅ Akun ${publicKey} berhasil dimuat. Urutan: ${account.sequence}`);

        // Mengambil semua saldo yang dapat diklaim untuk akun pengirim
        const claimables = await server.claimableBalances().claimant(publicKey).call();

        if (claimables.records.length === 0) {
            console.log("ℹ️ Tidak ada saldo yang dapat diklaim ditemukan untuk akun ini.");
            // Lanjutkan untuk menjalankan lagi setelah jeda
            return;
        }

        // Mengambil biaya dasar jaringan sekali
        const baseFee = (await server.fetchBaseFee()).toString();
        console.log(`💰 Menggunakan biaya dasar: ${baseFee} (dibayar oleh pengirim)`);

        // Inisialisasi pembangun transaksi dengan akun pengirim, biaya, dan frasa jaringan
        let transactionBuilder = new StellarSdk.TransactionBuilder(account, {
            fee: baseFee,
            networkPassphrase: 'Pi Network'
        });

        let operationsAdded = 0;
        const maxOperationsPerTransaction = 25; // Batas untuk pasangan klaim/pembayaran (total 50 operasi)

        // Iterasi melalui saldo yang dapat diklaim dan tambahkan operasi ke transaksi
        for (let cb of claimables.records) {
            // Batasi jumlah operasi untuk menghindari ukuran transaksi yang berlebihan
            if (operationsAdded >= maxOperationsPerTransaction) {
                console.log(`ℹ️ Mencapai batas ${maxOperationsPerTransaction} pasangan klaim/pembayaran. Memproses batch saat ini.`);
                break; // Hentikan penambahan operasi jika batas tercapai
            }

            const cbID = cb.id;
            const amount = cb.amount;
            const assetType = cb.asset_type;
            const assetCode = cb.asset_code;
            const assetIssuer = cb.asset_issuer;

            console.log(`✨ Menyiapkan untuk mengklaim Saldo ID: ${cbID} (Jumlah: ${amount} ${assetType === 'native' ? 'XLM' : assetCode})`);

            // Menentukan aset (native atau dikeluarkan)
            let asset;
            if (assetType === 'native') {
                asset = StellarSdk.Asset.native();
            } else {
                asset = new StellarSdk.Asset(assetCode, assetIssuer);
            }

            // Tambahkan operasi klaim saldo yang dapat diklaim
            transactionBuilder.addOperation(StellarSdk.Operation.claimClaimableBalance({
                balanceId: cbID,
                source: publicKey // Akun sumber untuk operasi klaim
            }));

            // Tambahkan operasi pembayaran untuk jumlah yang diklaim ke penerima
            transactionBuilder.addOperation(StellarSdk.Operation.payment({
                destination: receiver,
                asset: asset,
                amount: amount,
                source: publicKey // Akun sumber untuk operasi pembayaran
            }));

            operationsAdded++;
        }

        // Jika tidak ada operasi yang ditambahkan (misalnya, setelah filter batas), keluar
        if (operationsAdded === 0) {
            console.log("ℹ️ Tidak ada operasi klaim/transfer yang ditambahkan ke transaksi batch.");
            return;
        }

        // Atur batas waktu transaksi dan bangun transaksi
        let tx = transactionBuilder.setTimeout(30).build(); // Transaksi valid selama 30 detik

        // Tandatangani transaksi dengan keypair pengirim
        tx.sign(keypair);

        console.log(`🚀 Mengirimkan transaksi batch dengan ${operationsAdded} pasangan klaim/pembayaran...`);
        // Kirim transaksi ke jaringan Stellar
        const res = await server.submitTransaction(tx);

        // Tangani hasil transaksi
        if (res && res.hash) {
            console.log(`✅ Transaksi batch sukses! Hash: ${res.hash}`);
            await sendTelegramMessage(`✅ Klaim & Transfer Pi sukses!\nTx Hash: ${res.hash}\nJumlah operasi: ${operationsAdded} pasangan.`);
        } else {
            console.log("⚠️ Transaksi batch terkirim tapi tidak ada hash (kemungkinan tidak berhasil).");
            await sendTelegramMessage(`⚠️ Klaim & Transfer Pi gagal atau tanpa hash.\nJumlah operasi: ${operationsAdded} pasangan.`);
        }

    } catch (e) {
        // Penanganan kesalahan yang komprehensif
        console.error("❌ Terjadi kesalahan saat memproses klaim dan transfer:");
        if (e.response && e.response.data && e.response.data.extras && e.response.data.extras.result_codes) {
            console.error("Kode Hasil Rinci:", e.response.data.extras.result_codes);
            await sendTelegramMessage(`❌ Error saat klaim & transfer Pi:\n${JSON.stringify(e.response.data.extras.result_codes, null, 2)}`);
        } else {
            console.error("Pesan Kesalahan:", e.message || e);
            await sendTelegramMessage(`❌ Error saat klaim & transfer Pi:\n${e.message || JSON.stringify(e)}`);
        }
    } finally {
        // Ulangi fungsi setelah jeda singkat
        console.log("🔄 Menunggu 1 detik sebelum menjalankan lagi...");
        console.log("----------------------------------------------------------------");
        setTimeout(claimAndSend, 1000); // ulangi setiap 1 detik
    }
}

// Mulai proses klaim dan transfer
claimAndSend();
