'use strict';

const HD_HARDENED = 0x80000000,
    CIPHER_IVSIZE = 96 / 8,
    AUTH_SIZE = 128 / 8,
    CIPHER_TYPE = 'aes-256-gcm',
    MINIMAL_EXTENSION_VERSION = '1.0.9',
    PATH = [(10016 | HD_HARDENED) >>> 0, 0],
    NO_TRANSPORT = 'No trezor.js transport is available',
    NO_CONNECTED_DEVICES = 'No connected devices',
    DEVICE_IS_BOOTLOADER = 'Connected device is in bootloader mode',
    DEVICE_IS_EMPTY = 'Connected device is not initialized',
    NOT_INITIALIZED = 'Device not initialized',
    FIRMWARE_IS_OLD = 'Firmware of connected device is too old',
    CIPHER_CANCEL = 'CipherKeyValue cancelled',
    WRONG_PIN = 'Invalid PIN',

    DEFAULT_KEYPHRASE = 'Activate TREZOR Password Manager?',
    DEFAULT_NONCE = '2d650551248d792eabf628f451200d7f51cb63e46aadcbb1038aacb05e8c8aee2d650551248d792eabf628f451200d7f51cb63e46aadcbb1038aacb05e8c8aee';

var crypto = require('crypto');

class TrezorMgmt {

    constructor(storage, list) {
        this.storage = storage;
        this.trezorDevice = null;
        this.trezorConnected = false;
        this.current_ext_version = '';
        this.cryptoData = {
            'keyPhrase': DEFAULT_KEYPHRASE,
            'nonce': DEFAULT_NONCE,
            'enc': true,
            'askOnEnc': true
        };
        this.list = list;

        this.list.on('transport', (transport) => this.checkTransport(transport));
        this.list.on('connectUnacquired', (device) => this.connectedUnacquiredTrezor(device));
        this.list.on('connect', (device) => this.connectedNewTrezor(device));
        this.list.on('error', (error) => {
            console.log('List error:', error);
            if (this.storage.phase === 'LOADED') {
                this.disconnectCallback();
            }
            this.storage.emit('sendMessage', 'errorMsg', {code: 'T_LIST', msg: error});
        });
    }

    handleTrezorError(error, operation, fallback) {
        let never = new Promise(() => {
        });

        console.log(error);

        switch (error.message) {
            case NO_TRANSPORT:
                return never;
                break;

            case DEVICE_IS_EMPTY:
                return never;
                break;

            case FIRMWARE_IS_OLD:
                return never;
                break;

            case NO_CONNECTED_DEVICES:
                return never;
                break;

            case DEVICE_IS_BOOTLOADER:
                return never;
                break;

            case CIPHER_CANCEL:
                //TODO do it smart asshole!
                if (operation === 'encKey') {
                    return never;
                } else {
                    fallback();
                }
                break;

            case NOT_INITIALIZED:
                this.storage.emit('sendMessage', 'errorMsg', {code: 'T_NOT_INIT'});
                return never;
                break;

            case WRONG_PIN:
                this.storage.emit('sendMessage', 'wrongPin');
                //TODO it smart asshole!
                switch (operation) {
                    case 'encKey':
                        this.trezorDevice.runAggressive((session) => this.getEncryptionKey(session));
                        break;
                    case 'encEntry':
                        this.trezorDevice.runAggressive((session) => this.sendEncryptCallback(session));
                        break;
                    case 'decEntry':
                        this.trezorDevice.runAggressive((session) => this.sendDecryptCallback(session));
                        break;
                }
                break;
        }
    }

    checkTransport(transport) {
        this.current_ext_version = transport.version;
        this.checkVersions();
    }

    versionCompare(a, b) {
        let pa = a.split('.');
        let pb = b.split('.');
        for (let i = 0; i < 3; i++) {
            let na = Number(pa[i]);
            let nb = Number(pb[i]);
            if (na > nb) return true;
            if (nb > na) return false;
            if (!isNaN(na) && isNaN(nb)) return true;
            if (isNaN(na) && !isNaN(nb)) return false;
        }
        return false;
    }

    checkVersions() {
        this.storage.emit('checkReopen');
        if (this.current_ext_version !== '') {
            if (!this.versionCompare(this.current_ext_version, MINIMAL_EXTENSION_VERSION)) {
                // bad version
                this.storage.emit('sendMessage', 'errorMsg', {code: 'T_OLD_VERSION', msg: this.current_ext_version});
            }
        } else {
            // no extension
            this.storage.emit('sendMessage', 'errorMsg', {code: 'T_NO_TRANSPORT', msg: this.current_ext_version});
        }
    }

    connectedNewTrezor(device) {
        this.trezorDevice = device;
        this.connectTrezor();
    }

    connectedUnacquiredTrezor(unacquiredDevice) {
        this.unacquiredDevice = unacquiredDevice;
        this.unacquiredDevice.once('disconnect', () => this.disconnectedUnacquiredTrezor());
        this.unacquiredDevice.once('connect', () => this.disconnectedUnacquiredTrezor());
    }

    disconnectedUnacquiredTrezor() {
        this.unacquiredDevice = null;
    }

    stealTrezor() {
        if (this.unacquiredDevice != null) {
            this.unacquiredDevice.steal(); // no need to run connectTrezor again, will run automatically
        }
    }

    connectTrezor() {
        if (this.storage.phase === 'TREZOR') {
            var doSteal = this.trezorDevice == null;
            if (doSteal) {
                this.stealTrezor();
                return;
            }
            try {
                this.storage.emit('sendMessage', 'trezorConnected');
                this.trezorDevice.on('pin', (type, callback) => this.pinCallback(type, callback));
                this.trezorDevice.on('passphrase', (callback) => this.passphraseCallback(callback));
                this.trezorDevice.on('button', (type, callback) => this.buttonCallback(type, callback));
                this.trezorDevice.once('disconnect', () => this.disconnectCallback());

                var onChangedSessions = () => {
                    if (this.trezorDevice.isStolen()) {
                        // if device is stolen before we read encryption key...
                        if (this.storage.masterKey === '') {
                            // a quick hack - pretend that the device is disconnected if it's stolen
                            this.storage.emit('disconnectedTrezor');
                        }
                        this.trezorDevice.removeListener('changedSessions', onChangedSessions);
                    }
                };
                this.trezorDevice.on('changedSessions', onChangedSessions);

                if (this.trezorDevice.isBootloader()) {
                    this.storage.emit('sendMessage', 'errorMsg', {code: 'T_BOOTLOADER'});
                    throw new Error('Device is in bootloader mode, re-connected it');
                }
                this.trezorDevice.runAggressive((session) => this.getEncryptionKey(session));

            } catch (error) {
                this.storage.emit('sendMessage', 'errorMsg', {code: 'T_DEVICE', msg: error});
                console.error('Device error:', error);
                //TODO
            }
        }
    }

    clearSession() {
        this.trezorDevice.waitForSessionAndRun((session) => {
            return session.clearSession()
        });
    }

    pinCallback(type, callback) {
        this.trezorDevice.pinCallback = callback;
        this.storage.emit('showPinDialog');
    }

    pinEnter(pin) {
        this.trezorDevice.pinCallback(null, pin);
    }

    passphraseCallback(callback) {
        callback(null, '');
    }

    buttonCallback(type, callback) {
        this.storage.emit('sendMessage', 'showButtonDialog');
        this.trezorDevice.buttonCallback = callback;
    }

    buttonEnter(code) {
        this.trezorDevice.buttonCallback(null, code);
    }

    disconnectCallback() {
        this.storage.masterKey = '';
        this.storage.encryptionKey = '';
        this.trezorDevice = null;
        this.cryptoData = {
            'keyPhrase': DEFAULT_KEYPHRASE,
            'nonce': DEFAULT_NONCE,
            'enc': true,
            'askOnEnc': true
        };
        this.storage.emit('disconnectedTrezor');
    }

    randomInputVector() {
        return new Promise((resolve, reject) => {
            try {
                crypto.randomBytes(CIPHER_IVSIZE, (err, buf) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(buf);
                    }
                })
            } catch (err) {
                reject(err);
                //TODO
            }
        });
    }

    encrypt(data, key) {
        return this.randomInputVector().then((iv) => {
            let stringified = JSON.stringify(data),
                buffer = new Buffer(stringified, 'utf8'),
                cipher = crypto.createCipheriv(CIPHER_TYPE, key, iv),
                startCText = cipher.update(buffer),
                endCText = cipher.final(),
                auth_tag = cipher.getAuthTag();
            return Buffer.concat([iv, auth_tag, startCText, endCText]);
        });
    }

    decrypt(data, key) {
        try {
            let iv = data.slice(0, CIPHER_IVSIZE),
                auth_tag = data.slice(CIPHER_IVSIZE, CIPHER_IVSIZE + AUTH_SIZE),
                cText = data.slice(CIPHER_IVSIZE + AUTH_SIZE),
                decipher = crypto.createDecipheriv(CIPHER_TYPE, key, iv),
                start = decipher.update(cText);
            decipher.setAuthTag(auth_tag);
            let end = decipher.final();
            return Buffer.concat([start, end]).toString('utf8');
        } catch (error) {
            console.error('error ', error);
            //TODO
        }
    }

    displayKey(title, username) {
        title = this.storage.isUrl(title) ? this.storage.decomposeUrl(title).domain : title;
        return 'Unlock ' + title + ' for user ' + username + '?';
    }

    encryptFullEntry(data, responseCallback) {
        crypto.randomBytes(32, (ex, buf) => {
            this.cryptoData = {
                'title': data.title,
                'username': data.username,
                'password': data.password,
                'safe_note': data.safe_note,
                'keyPhrase': this.displayKey(data.title, data.username),
                'nonce': buf.toString('hex'),
                'callback': responseCallback,
                'enc': true,
                'askOnEnc': false
            };
            this.trezorDevice.runAggressive((session) => this.sendEncryptCallback(session));
        });
    }

    sendEncryptCallback(session) {
        return session.cipherKeyValue(PATH, this.cryptoData.keyPhrase, this.cryptoData.nonce, this.cryptoData.enc, this.cryptoData.askOnEnc, true).then((result) => {
            let enckey = new Buffer(this.cryptoData.nonce, 'hex');
            this.encrypt(this.cryptoData.password, enckey).then((password)=> {
                this.encrypt(this.cryptoData.safe_note, enckey).then((safenote)=> {
                    this.cryptoData.callback({
                        content: {
                            title: this.cryptoData.title,
                            username: this.cryptoData.username,
                            password: password,
                            safe_note: safenote,
                            nonce: result.message.value
                        }
                    });
                });
            });
        }).catch((error) => this.handleTrezorError(error, 'encEntry', this.cryptoData.callback));
    }

    decryptFullEntry(data, responseCallback) {
        this.cryptoData = {
            'title': data.title,
            'username': data.username,
            'password': data.password,
            'safe_note': data.safe_note,
            'keyPhrase': this.displayKey(data.title, data.username),
            'nonce': data.nonce,
            'callback': responseCallback,
            'enc': false,
            'askOnEnc': false
        };
        this.trezorDevice.runAggressive((session) => this.sendDecryptCallback(session));
    }

    sendDecryptCallback(session) {
        return session.cipherKeyValue(PATH, this.cryptoData.keyPhrase, this.cryptoData.nonce, this.cryptoData.enc, this.cryptoData.askOnEnc, true).then((result) => {
            let enckey = new Buffer(result.message.value, 'hex'),
                password = new Buffer(this.cryptoData.password),
                safenote = new Buffer(this.cryptoData.safe_note);
            this.cryptoData.callback({
                content: {
                    title: this.cryptoData.title,
                    username: this.cryptoData.username,
                    password: JSON.parse(this.decrypt(password, enckey)),
                    safe_note: JSON.parse(this.decrypt(safenote, enckey)),
                    nonce: this.cryptoData.nonce
                }
            });
        }).catch((error) => this.handleTrezorError(error, 'decEntry', this.cryptoData.callback));
    }

    getEncryptionKey(session) {
        return session.cipherKeyValue(PATH, this.cryptoData.keyPhrase, this.cryptoData.nonce, this.cryptoData.enc, this.cryptoData.askOnEnc, true).then((result) => {
            this.storage.emit('sendMessage', 'loading', 'We\'re getting there ...');
            this.storage.masterKey = result.message.value;
            let temp = this.storage.masterKey;
            this.storage.encryptionKey = new Buffer(temp.substring(temp.length / 2, temp.length), 'hex');
            this.storage.emit('loadFile');
        }).catch((error) => this.handleTrezorError(error, 'encKey', null));
    }
}
module.exports = TrezorMgmt;
