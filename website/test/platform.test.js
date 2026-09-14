import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectPlatform, downloadURLs } from '../src/platform.js';

const UA = {
	windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
	macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
	macFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15.6; rv:143.0) Gecko/20100101 Firefox/143.0',
	iPhone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
	iPad: 'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
	linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
	android: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
	bot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
};

test('uses the Sec-CH-UA-Platform hint first', () => {
	assert.equal(detectPlatform('"Windows"', UA.macSafari), 'windows');
	assert.equal(detectPlatform('"macOS"', UA.windows), 'mac');
	assert.equal(detectPlatform('"Linux"', UA.windows), 'unknown');
	assert.equal(detectPlatform('"Android"', ''), 'unknown');
});

test('falls back to the User-Agent without a useful hint', () => {
	assert.equal(detectPlatform(null, UA.windows), 'windows');
	assert.equal(detectPlatform('', UA.macSafari), 'mac');
	assert.equal(detectPlatform('"Unknown"', UA.macFirefox), 'mac');
});

test('treats iOS, Linux, Android, bots and missing headers as unknown', () => {
	for (const ua of [UA.iPhone, UA.iPad, UA.linux, UA.android, UA.bot, '', null]) {
		assert.equal(detectPlatform(null, ua), 'unknown', String(ua));
	}
});

test('reads per-platform download URLs, with DOWNLOAD_URL as the old Mac name', () => {
	assert.deepEqual(downloadURLs({ MAC_DOWNLOAD_URL: ' https://example.com/a.dmg ', WINDOWS_DOWNLOAD_URL: '' }), {
		mac: 'https://example.com/a.dmg',
		windows: '',
	});
	assert.deepEqual(downloadURLs({ DOWNLOAD_URL: 'https://example.com/old.dmg' }), {
		mac: 'https://example.com/old.dmg',
		windows: '',
	});
	assert.equal(downloadURLs({ MAC_DOWNLOAD_URL: 'https://example.com/new.dmg', DOWNLOAD_URL: 'https://example.com/old.dmg' }).mac, 'https://example.com/new.dmg');
});
