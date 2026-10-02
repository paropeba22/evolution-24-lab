ALTER TABLE `NexiGroupControl`
  ADD CONSTRAINT `NexiGroupControl_authority_check` CHECK (`generation` > 0 AND `revision` >= 0 AND `state` IN ('active','revoked'));
ALTER TABLE `NexiGroupEventOutbox`
  ADD CONSTRAINT `NexiGroupEventOutbox_retention_check` CHECK (`attempts` >= 0 AND `state` IN ('queued','delivered','rejected','quarantined'));
