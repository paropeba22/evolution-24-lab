#!/usr/bin/env bash
# Prepared READ-ONLY. Luna fills confirmed NEXI identifiers; owner runs in SSH.
# Never enable set -x. Does not boot an app, print secrets or read auth values.
set -eu
: "${NEXI_WEB_SERVICE:?confirmed Swarm service NAME required}"
: "${NEXI_WORKER_SERVICE:?confirmed Swarm service NAME required}"
: "${NEXI_EVO_SERVICE:?confirmed Swarm service NAME required}"
: "${NEXI_EVO_CONTAINER:?confirmed running Evolution task container required}"

for service in "$NEXI_WEB_SERVICE" "$NEXI_WORKER_SERVICE" "$NEXI_EVO_SERVICE"; do
  docker service inspect --format 'service={{.Spec.Name}} id={{.ID}} replicas={{.Spec.Mode.Replicated.Replicas}} image={{.Spec.TaskTemplate.ContainerSpec.Image}} update={{json .Spec.UpdateConfig}} rollback={{json .Spec.RollbackConfig}} stop_grace={{.Spec.TaskTemplate.ContainerSpec.StopGracePeriod}}' "$service"
  docker service ps --no-trunc --format 'task={{.ID}} node={{.Node}} desired={{.DesiredState}} current={{.CurrentState}} image={{.Image}}' "$service"
  # Print only the recognized hold setting, never other environment variables.
  docker service inspect --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{if eq . "NEXI_ATTENDANCE_CUTOVER_HOLD=true"}}cutover_hold_explicit_true{{println}}{{else if eq . "NEXI_ATTENDANCE_CUTOVER_HOLD=false"}}cutover_hold_explicit_false{{println}}{{end}}{{end}}' "$service"
done

actual_service=$(docker inspect --type container --format '{{index .Config.Labels "com.docker.swarm.service.name"}}' "$NEXI_EVO_CONTAINER")
test "$actual_service" = "$NEXI_EVO_SERVICE" || { echo 'STOP: task does not belong to confirmed NEXI Evolution service' >&2; exit 1; }
docker inspect --type container --format 'container={{.Id}} image_id={{.Image}} running={{.State.Running}} oom={{.State.OOMKilled}} exit={{.State.ExitCode}} sandbox={{.NetworkSettings.SandboxKey}}' "$NEXI_EVO_CONTAINER"
docker inspect --type container --format '{{range .Mounts}}mount type={{.Type}} name={{.Name}} destination={{.Destination}} rw={{.RW}}{{println}}{{end}}' "$NEXI_EVO_CONTAINER"
image_id=$(docker inspect --type container --format '{{.Image}}' "$NEXI_EVO_CONTAINER")
docker image inspect --format 'image_id={{.Id}} repo_digests={{json .RepoDigests}}' "$image_id"
docker exec -i "$NEXI_EVO_CONTAINER" node - <<'NODE'
const fs=require('node:fs'),crypto=require('node:crypto');
const raw=process.env.NEXI_ATTENDANCE_CUTOVER_HOLD;
console.log(JSON.stringify({node:process.version,hold_explicit_true:raw==='true',
  hold_requested_by_config:raw!==undefined&&raw!=='false',hold_config_valid:raw==='true'||raw==='false'}));
const descriptor='/tmp/nexi-attendance-cutover-current.json';
if(fs.existsSync(descriptor)){
  const current=JSON.parse(fs.readFileSync(descriptor,'utf8'));
  const boot=current.boot_id;
  if(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(boot||'')){
    const release=`/tmp/nexi-attendance-cutover-${boot}.release`;
    console.log(JSON.stringify({boot_id:boot,hold_configured:current.hold===true,
      pid1:fs.readFileSync('/proc/1/comm','utf8').trim(),
      current_boot_released:fs.existsSync(release)&&fs.readFileSync(release,'utf8')===`${boot}\n`}));
  }
}
for(const name of ['dist/main.js','package.json','nexi-start.sh','nexi-attendance.cjs',
  'nexi-attendance-authority.cjs','nexi-attendance-dispatch.cjs']){
  const file='/evolution/'+name;
  console.log(JSON.stringify({file:name,exists:fs.existsSync(file),sha256:fs.existsSync(file)?
    crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null}));
}
NODE
