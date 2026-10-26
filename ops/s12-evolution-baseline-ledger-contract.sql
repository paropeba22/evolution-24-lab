-- PREPARED / NEVER EXECUTED. Include only inside the preflight READ ONLY transaction.
-- Exact source baseline at a2ad9338c5901f10d001495ba357938915d28c79: 70 migrations
-- before owner-generation. These are raw Git blob hashes, NOT verified deployed
-- checksums. Final provider/staging bytes and ledger evidence remain a separate
-- blocking gate; matching this source contract alone never authorizes migration.
DO $ledger_gate$
DECLARE mismatch_count bigint;
BEGIN
  IF current_setting('transaction_read_only')<>'on' OR current_database()<>'nexi'
    OR session_user<>'nexi_evolution_migrator' OR current_user<>'nexi_evolution_guard_owner'
  THEN RAISE EXCEPTION 'baseline ledger gate requires reviewed read-only migration session'; END IF;
  WITH expected(migration_name,checksum) AS (
    VALUES
      ('20240609181238_init','7507eff6b49fad53cdd0b3ace500f529597dfa1a8987afbb9807968a8ee8ef49'),
      ('20240610144159_create_column_profile_name_instance','914eeefb9eba0dacdbcb7cdbe47567abd957543d6f27c39db4eec6a40c864008'),
      ('20240611125754_create_columns_whitelabel_chatwoot','50d6920345af06dbd5086959784b7e2b4d163a5b555ff1029e5f81678a454444'),
      ('20240611202817_create_columns_debounce_time_typebot','b90c49299ed812fb46b71a4f0b9f818b7fc7109c52b1aff227a107236839d93c'),
      ('20240712144948_add_business_id_column_to_instances','01303057a037f5dc28272ac513b60d5a75be71d1bf727e671ca538db3268fa2e'),
      ('20240712150256_create_templates_table','34235c250eb1f088c285489ad690b4c045680f1638076436cdc66de0ea382cc2'),
      ('20240712155950_adjusts_in_templates_table','0ba192ba428c9ab5a9b31d1f7d73603ee47b6192e2f8c590f6d93ade0dbdbccf'),
      ('20240712162206_remove_templates_table','426256b73f7ea52538dc91a890179c841325a9c387cf02885b81971d582af830'),
      ('20240712223655_column_fallback_typebot','3496739609829e80daf733baecd3d3e4e279bf318a99adc1ca3aa1c76f893b2f'),
      ('20240712230631_column_ignore_jids_typebot','bea48f697c0c5db52ade4a3f26c1321e3f5611c80ea50384baa54e58c6b3a79e'),
      ('20240713184337_add_media_table','1bac56740af5d2d6512b29e7a6e0721d69b2a290400f6660b92b6f2d8b30cd6e'),
      ('20240718121437_add_openai_tables','bdd992b253321ca9a9556e30fea5e7760556cb8e80140aec34066301b55dc675'),
      ('20240718123923_adjusts_openai_tables','8147ec0cc86ac30ea1be05d461559ba5064273a3fcb3227af71ddcd895f5aebe'),
      ('20240722173259_add_name_column_to_openai_creds','8c2a595975dc2f6dee831983304996e25c37014c48291576e7c8044078bfde32'),
      ('20240722173518_add_name_column_to_openai_creds','20b3c04d93799c25fa8b2d0a85d10f9280e915a5d7519542492ed85ff082a3c0'),
      ('20240723152648_adjusts_in_column_openai_creds','7ffb91b84cb7aa17b1f488d580626144cd557ccdfaec6654515545401d1938af'),
      ('20240723200254_add_webhookurl_on_message','3056f8f1335e8933e4098f005e33cd4821190be2eb76520c0d01e2e13cf6e073'),
      ('20240725184147_create_template_table','9d6c9b4ffe51483a851f6507f7aefd2fb34f54a7c28961856e3230fda4f87022'),
      ('20240725202651_add_webhook_url_template_table','94e2edb21107895c77b24402f41cd020c7f74dbb39b9a95664a45e62e2582be9'),
      ('20240725221646_modify_token_instance_table','d0da588e4204c50bde2e41a615b9301afca072991033545b6f4e3e34e088db87'),
      ('20240729115127_modify_trigger_type_openai_typebot_table','a80f5c27cd80d088ea69153f8d6f4879406770ffa5a7fd50b28da82bd020322e'),
      ('20240729180347_modify_typebot_session_status_openai_typebot_table','c29ccc88930138c50091712466f3f97bff48f6a0f486dcec5b19dc08c3612973'),
      ('20240730152156_create_dify_tables','961a8627684fe1e4c7123565db3d16db30768df41881342032f9a2df16145eaf'),
      ('20240801193907_add_column_speech_to_text_openai_setting_table','b56b053451d564ff6282078fad4fc7bff4aa71e3b0b8d00bf219da4ed1bc4c86'),
      ('20240803163908_add_column_description_on_integrations_table','2b963cbc826ea024f9a643af2d5d9fcea06717c90ec9bacb255d3836efa06aea'),
      ('20240808210239_add_column_function_url_openaibot_table','4d2dd947ebb7515c7c278472a10ebab6d5f41a5ef60e15df717a05d457d5d2aa'),
      ('20240811021156_add_chat_name_column','c8627bad5d72ee4ef774ed32c95a2524517b0c60c49fa67cd4ba9dff7cbdde3b'),
      ('20240811183328_add_unique_index_for_remoted_jid_and_instance_in_contacts','ee44f0420384d55de6d252fffb8f2cfa88479e5811e14cfe975d8edfcc6957e0'),
      ('20240813003116_make_label_unique_for_instance','29c330029a48aaee63567e63c4f4e57b7c1f5344162b11fbf61a4dc194547861'),
      ('20240814173033_add_ignore_jids_chatwoot','428a9148f2a29f773e0c9813149e6d07bf51765e018652aeac0be2141a722b67'),
      ('20240814202359_integrations_unification','e1eb8997ac99fd555b8a9241c817b97fa5614124922b4e6b3cb1751e9e2199c7'),
      ('20240817110155_add_trigger_type_advanced','bc5cd1c7fb4df72e88cb4856c9c49ea340284c9d8f389fe558008a921494ed82'),
      ('20240819154941_add_context_to_integration_session','1af30cbbccd90152fbb1b99a458978e42428a792b822b4b5f9c9c7fffbf7264f'),
      ('20240821120816_bot_id_integration_session','a363a9ebc5bb526e504c4e6f71ed7702a5b6d317db6a9981f36c4560f9147fba'),
      ('20240821171327_add_generic_bot_table','e31947e6c709ee3a62504980ae9ab1ffbfd9faf0cf9ac389cfd6435734c49902'),
      ('20240821194524_add_flowise_table','18dde8e48c49a97f33f5b789ccd919326253c26d43af72c77f6b13d4285ffba8'),
      ('20240824161333_add_type_on_integration_sessions','0148a09e0e5eedafe5c5169c6351201a5c70ebaa853456693d75a7b82a851dbe'),
      ('20240825130616_change_to_evolution_bot','710e7ee3aabf07aa6ee9bf2865c09f75d461efa5724dd83f5a6f324ea1e5e47c'),
      ('20240828140837_add_is_on_whatsapp_table','d03a8a31df36eb0a07e80cd2a149b6d826e69bb2cb21fbe69943ae5ffba672ad'),
      ('20240828141556_remove_name_column_from_on_whatsapp_table','e927e00343b622bee7dab1b9b5c9fdd95007bfaf9d705ec52db9ecb05fb3d078'),
      ('20240830193533_changed_table_case','cf00d8ef2c28cf94aea51e7e2a80ddd65474a4f6c1113abc65dea6cc194c1a57'),
      ('20240906202019_add_headers_on_webhook_config','1cc60b9c38db62b694f753e2ee4c155e95c66815b5800f6ddb6f7cddec23b1ad'),
      ('20241001180457_add_message_status','7dff7227c1e013127210ab4f77b91dc24eae14bcd07f21fb27aaa2fa82b23865'),
      ('20241006130306_alter_status_on_message_table','07449acbac59175f82670f34664c1dcea4d34f9a1710f19bd3396e26868db09e'),
      ('20241007164026_add_unread_messages_on_chat_table','7e9a7c45f05285e9fea38ccfa4266790a099107605299d81c309e689c06494ef'),
      ('20241011085129_create_pusher_table','7e3e4686eb8009cbf0f71e8606a442b1c2862673dbc654b3f36f39a36efcb586'),
      ('20241011100803_split_messages_and_time_per_char_integrations','270e1e51c7b9d24c0e68708ad167cb5748d591fd194ad422486574a0e83c0b79'),
      ('20241017144950_create_index','e82282df963a32556a9c8cd5fd908dd5810d4c35f0d7765ab9e844ebad1106a2'),
      ('20250116001415_add_wavoip_token_to_settings_table','668e44d3cd8caafa8f60f89805e9f80587c1c69b4d52a21dfc79f4b615125b1c'),
      ('20250225180031_add_nats_integration','17983175f27c61a0ee6aaa42c94d665cabb7e904ee91c33f867c657512210e1a'),
      ('20250514232744_add_n8n_table','0a6034359b1cf68820e829d31402032eed0f77586fb1ee590a98f5a6c3e15847'),
      ('20250515211815_add_evoai_table','f9ddf352b22e52a1f466d40df95da7bd6f4bf51310c07911d9c990f720e1fe81'),
      ('20250516012152_remove_unique_atribute_for_file_name_in_media','7a03627d41844a016b28b4194e36eea0e52cd24be0061535fecba4ccbd0e72f4'),
      ('20250612155048_add_coluns_trypebot_tables','3fca4961d4e7fa8e1a99e3ec6b072d235bec706b7463ab699887be1084e3b656'),
      ('20250613143000_add_lid_column_to_is_onwhatsapp','36a19fe7711b98d02b450aedb2de8802b5e2e635a1e530cbc42f1d184e89bec3'),
      ('20250918182355_add_kafka_integration','2b9d50b837a154ee3a74284c130b21fbe10ecddc1159cb29dac74c4ba4cb6a5f'),
      ('20251122003044_add_chat_instance_remotejid_unique','84053d218d69e85953f7533bbfced9171e762c02c88ab944aaaa75b17f18e161'),
      ('20251216143054_increase_token_length','75bf5f658ead0ca12ea58eabd7ffcc4411d94c3d2ff9a6ca050d4e1fa3c9161a'),
      ('20260506184850_add_runtime_config','17efc12cc44028e72a66cddeb41be00b7abdbac7d1bbd5e2e9408ad14c4535e0'),
      ('20260926000000_add_chatwoot_inbox_id','6e7004d282dd2e196e5737ea40e2c0f0aaee287cac98e5054d60f700a1580b90'),
      ('20261002000000_nexi_groups_wave1','dfbae110b75f4dcfc981677eab787491813ec99a9968053f4bc6621e7cf7985c'),
      ('20261002000001_harden_groups_wave1','8a7bb12eace9434ced34834c0b3abe193d31c9db6603e070143110cdb9c1afa5'),
      ('20261002000002_namespace_groups_source','2400f3e45fba4f0e6d2ad307a8a20abec502fb4acb5d7da255a29c1d37c70dcd'),
      ('20261005000000_nexi_attendance_boundaries','57f49c82bc9340a7f1db76b3fa1ce6648bc0f07ba404bd0f3da96c111539486f'),
      ('20261005000001_attendance_canonical_version','0214f56e508df1d81b23700ee6ca73c554f82945db1ffc898d5a58b626ca4ab1'),
      ('20261006000000_attendance_release_dispatch','2a8daff6ce7b8bc16173d2babbe70c7e580237d90291df8d465f693d6647580f'),
      ('20261010000000_attendance_physical_dispatch','a17cff382193662ebd2598e59d8d559d7e7a642cd0137a8754007ddcd46af2ae'),
      ('20261015000000_nexi_durable_ingress','042e4282213477a330644a5017621f1646793880c141b195c82092bf0009ba04'),
      ('20261015000001_nexi_ingress_secondary','f9e556dd35b041ce92b9a860ab5b49002dfc553d0c2f3f043edc199e8ee8be6d'),
      ('20261015000002_nexi_ingress_contact_cache','3c6a65a339cae039d0742337ae76bec09f5890b8f0786dfa9e61b6e0ec0a599c')
  ), active AS (
    SELECT migration_name,checksum,finished_at,applied_steps_count
    FROM public."_prisma_migrations" WHERE rolled_back_at IS NULL
  )
  SELECT count(*) INTO mismatch_count
  FROM expected e FULL JOIN active a USING (migration_name)
  WHERE e.migration_name IS NULL OR a.migration_name IS NULL
    OR a.finished_at IS NULL OR a.applied_steps_count IS NULL OR a.applied_steps_count<1
    OR a.checksum IS DISTINCT FROM e.checksum;
  IF mismatch_count<>0 OR EXISTS (
    SELECT 1 FROM public."_prisma_migrations" WHERE rolled_back_at IS NULL
      GROUP BY migration_name HAVING count(*)<>1
  ) THEN RAISE EXCEPTION 'baseline ledger missing, unexpected, duplicate, incomplete or checksum mismatch'; END IF;
END $ledger_gate$;
