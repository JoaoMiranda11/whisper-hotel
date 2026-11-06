-- Optional DEV helper: a second account to test proximity voice with two browsers.
-- NOT auto-run. Apply on a running stack:
--   docker exec -i mysql mariadb -uroot -parcturus_root_pw arcturus < mysql/dev/voice_second_user.sql
-- Then log in with ?sso=456 (and mint a voice pass for this user's id; see docs/voice.md).
-- Idempotent. Never use these tickets outside local dev.

INSERT INTO `users` (`username`, `real_name`, `password`, `mail`, `account_created`, `motto`, `auth_ticket`, `ip_register`, `ip_current`)
SELECT 'VoiceTester', 'VoiceTester', '', 'voicetester@localhost', UNIX_TIMESTAMP(), 'proximity voice test', '456', '127.0.0.1', '127.0.0.1'
WHERE NOT EXISTS (SELECT 1 FROM `users` WHERE `username` = 'VoiceTester');

INSERT INTO `users_settings` (`user_id`)
SELECT u.`id` FROM `users` u
WHERE u.`username` = 'VoiceTester' AND NOT EXISTS (SELECT 1 FROM `users_settings` s WHERE s.`user_id` = u.`id`);

INSERT INTO `user_window_settings` (`user_id`)
SELECT u.`id` FROM `users` u
WHERE u.`username` = 'VoiceTester' AND NOT EXISTS (SELECT 1 FROM `user_window_settings` w WHERE w.`user_id` = u.`id`);

SELECT `id`, `username`, `auth_ticket` FROM `users` WHERE `username` = 'VoiceTester';
