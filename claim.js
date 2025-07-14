const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const axios = require('axios');
require("dotenv").config();

// Konstanta untuk menjaga saldo minimum di akun pengirim
const MIN_RESERVE_FOR_FEES = 0.3; // Jumlah Pi yang akan ditinggalkan di akun pengirim

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
 * @description Fungsi utama untuk mengklaim saldo yang dapat diklaim dan mentransfernya dalam batch,
 * lalu menguras semua saldo Pi yang tersisa ke alamat penerima.
 * Biaya transaksi dibayar oleh akun sponsor.
 */
async function claimAndSend() {
    const mnemonic = process.env.MNEMONIC;
    const receiver = process.env.RECEIVER_ADDRESS;
    // Variabel lingkungan baru untuk mnemonik sponsor
    const sponsorMnemonic = process.env.SPONSOR_MNEMONIC;

    if (!mnemonic || !receiver || !sponsorMnemonic) {
        console.error("❌ Pastikan MNEMONIC, RECEIVER_ADDRESS, dan SPONSOR_MNEMONIC diatur di file .env Anda.");
        // Hentikan eksekusi jika variabel lingkungan tidak diatur
        return;
    }

    try {
        // Mendapatkan public dan secret key dari mnemonik pengirim
        const { publicKey, secretKey } = await getPiWalletAddressFromSeed(mnemonic);
        // Membuat keypair pengirim dari secret key
        const keypair = StellarSdk.Keypair.fromSecret(secretKey);

        // Mendapatkan public dan secret key dari mnemonik sponsor
        const { publicKey: sponsorPublicKey, secretKey: sponsorSecretKey } = await getPiWalletAddressFromSeed(sponsorMnemonic);
        // Membuat keypair sponsor dari secret key sponsor
        const sponsorKeypair = StellarSdk.Keypair.fromSecret(sponsorSecretKey);

        // Inisialisasi server Stellar untuk Pi Network
        const server = new StellarSdk.Server('https://api.mainnet.minepi.com');

        console.log("🔑 Sender Public Key:", publicKey);
        console.log("🎯 Receiver Address:", receiver);
        console.log("💸 Sponsor Public Key:", sponsorPublicKey);

        // Memuat detail akun pengirim
        let account = await server.loadAccount(publicKey);
        console.log(`✅ Akun pengirim ${publicKey} berhasil dimuat. Urutan: ${account.sequence}`);

        // Memuat detail akun sponsor
        let sponsorAccount = await server.loadAccount(sponsorPublicKey);
        console.log(`✅ Akun sponsor ${sponsorPublicKey} berhasil dimuat. Urutan: ${sponsorAccount.sequence}`);

        // Mengambil semua saldo yang dapat diklaim untuk akun pengirim
        const claimables = await server.claimableBalances().claimant(publicKey).call();

        if (claimables.records.length === 0) {
            console.log("ℹ️ Tidak ada saldo yang dapat diklaim ditemukan untuk akun ini.");
        } else {
            // Mengambil biaya dasar jaringan sekali
            const baseFee = (await server.fetchBaseFee()).toString();
            console.log(`💰 Menggunakan biaya dasar: ${baseFee} (dibayar oleh sponsor)`);

            // Inisialisasi pembangun transaksi dengan AKUN SPONSOR sebagai sumber.
            // Ini berarti biaya transaksi akan dibayar oleh akun sponsor.
            let transactionBuilder = new StellarSdk.TransactionBuilder(sponsorAccount, {
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

                // Tambahkan operasi klaim saldo yang dapat diklaim.
                // Sumber operasi adalah akun pengirim (publicKey) karena operasi ini memengaruhi saldo pengirim.
                transactionBuilder.addOperation(StellarSdk.Operation.claimClaimableBalance({
                    balanceId: cbID,
                    source: publicKey
                }));

                // Tambahkan operasi pembayaran untuk jumlah yang diklaim ke penerima.
                // Sumber operasi adalah akun pengirim (publicKey) karena ini adalah transfer dari pengirim.
                transactionBuilder.addOperation(StellarSdk.Operation.payment({
                    destination: receiver,
                    asset: asset,
                    amount: amount,
                    source: publicKey
                }));

                operationsAdded++;
            }

            // Jika ada operasi yang ditambahkan, kirim transaksi batch
            if (operationsAdded > 0) {
                // Atur batas waktu transaksi dan bangun transaksi
                let tx = transactionBuilder.setTimeout(30).build(); // Transaksi valid selama 30 detik

                // Tandatangani transaksi dengan keypair sponsor (untuk membayar biaya)
                tx.sign(sponsorKeypair);
                // Tandatangani transaksi dengan keypair pengirim (karena operasi bersumber dari akun pengirim)
                tx.sign(keypair);

                console.log(`🚀 Mengirimkan transaksi batch dengan ${operationsAdded} pasangan klaim/pembayaran...`);
                // Kirim transaksi ke jaringan Stellar
                const res = await server.submitTransaction(tx);

                // Tangani hasil transaksi
                if (res && res.hash) {
                    console.log(`✅ Transaksi batch sukses! Hash: ${res.hash}`);
                    await sendTelegramMessage(`✅ Klaim & Transfer Pi sukses (fee dibayar sponsor)!\nTx Hash: ${res.hash}\nJumlah operasi: ${operationsAdded} pasangan.`);
                } else {
                    console.log("⚠️ Transaksi batch terkirim tapi tidak ada hash (kemungkinan tidak berhasil).");
                    await sendTelegramMessage(`⚠️ Klaim & Transfer Pi gagal atau tanpa hash (fee dibayar sponsor).\nJumlah operasi: ${operationsAdded} pasangan.`);
                }
            } else {
                console.log("ℹ️ Tidak ada operasi klaim/transfer yang ditambahkan ke transaksi batch.");
            }
        }

        // --- Bagian baru: Menguras semua saldo Pi yang tersisa ---
        console.log("--- Memeriksa saldo Pi yang tersisa untuk pengurasan ---");
        // Muat ulang akun pengirim untuk mendapatkan saldo terbaru setelah klaim
        account = await server.loadAccount(publicKey);
        const currentNativeBalance = parseFloat(account.balances.find(b => b.asset_type === 'native')?.balance || '0');

        console.log(`📊 Saldo Pi saat ini di akun pengirim: ${currentNativeBalance}`);

        // Hitung jumlah yang akan dikirim, menyisakan MIN_RESERVE_FOR_FEES
        const amountToSweep = currentNativeBalance - MIN_RESERVE_FOR_FEES;

        if (amountToSweep > 0) {
            console.log(`💸 Menyiapkan untuk menguras ${amountToSweep.toFixed(7)} Pi dari ${publicKey} ke ${receiver}`);

            const baseFeeForSweep = (await server.fetchBaseFee()).toString();
            console.log(`💰 Menggunakan biaya dasar untuk pengurasan: ${baseFeeForSweep} (dibayar oleh sponsor)`);

            // Muat ulang akun sponsor untuk mendapatkan urutan terbaru sebelum membuat transaksi baru
            sponsorAccount = await server.loadAccount(sponsorPublicKey);

            // Buat transaksi pembayaran terpisah untuk menguras saldo.
            // Transaksi ini juga dibangun dari akun sponsor untuk membayar biaya.
            const sweepTx = new StellarSdk.TransactionBuilder(sponsorAccount, {
                fee: baseFeeForSweep,
                networkPassphrase: 'Pi Network'
            })
                .addOperation(StellarSdk.Operation.payment({
                    destination: receiver,
                    asset: StellarSdk.Asset.native(),
                    amount: amountToSweep.toFixed(7), // Format ke 7 desimal
                    source: publicKey // Sumber pembayaran adalah akun pengirim
                }))
                .setTimeout(30)
                .build();

            // Tandatangani transaksi pengurasan dengan keypair sponsor
            sweepTx.sign(sponsorKeypair);
            // Tandatangani transaksi pengurasan dengan keypair pengirim (karena operasi bersumber dari akun pengirim)
            sweepTx.sign(keypair);

            console.log("🚀 Mengirimkan transaksi pengurasan saldo...");
            const sweepResult = await server.submitTransaction(sweepTx);

            if (sweepResult && sweepResult.hash) {
                console.log(`✅ Pengurasan saldo sukses! Hash: ${sweepResult.hash}`);
                await sendTelegramMessage(`✅ Pengurasan saldo Pi sukses (fee dibayar sponsor)!\nJumlah: ${amountToSweep.toFixed(7)} Pi\nTx Hash: ${sweepResult.hash}`);
            } else {
                console.log("⚠️ Pengurasan saldo gagal: transaksi tidak valid atau tanpa hash.");
                await sendTelegramMessage(`⚠️ Pengurasan saldo Pi gagal atau tanpa hash (fee dibayar sponsor).\nJumlah: ${amountToSweep.toFixed(7)} Pi`);
            }
        } else {
            console.log("ℹ️ Saldo tidak cukup untuk pengurasan setelah menyisakan biaya.");
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
        setTimeout(claimAndSend, 449); // ulangi setiap 1 detik
    }
}

// Mulai proses klaim dan transfer
claimAndSend();
