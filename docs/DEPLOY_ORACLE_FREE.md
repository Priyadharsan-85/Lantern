# Trial deployment on Oracle Cloud Always Free

This guide prepares a small Ubuntu ARM VM for Lantern's existing production
Docker Compose stack. Oracle's Always Free capacity is not an availability
guarantee: capacity can be unavailable, and Oracle may reclaim an idle A1 VM.
Use this for a trial deployment, not for a service that needs an uptime SLA.

Oracle currently includes up to 2 Ampere A1 OCPUs and 12 GB of memory, plus
200 GB of Always Free block-volume storage per tenancy. The free compute quota
is shared across A1 instances. Oracle may reclaim an Always Free instance when,
over a 7-day period, CPU utilization at the 95th percentile, network
utilization, and (for A1 instances) memory utilization are each below 20%.
Account creation
requires identity and payment-card verification. Review Oracle's current
[Always Free resource limits](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
and cost details before creating resources; do not assume optional networking
or storage resources are free.

## 1. Create the VM

In the Oracle Cloud Console:

1. Create an Ubuntu 24.04 ARM (aarch64) instance in your home region.
2. Select **VM.Standard.A1.Flex** and allocate no more than the Always Free
   allowance of 2 OCPUs and 12 GB RAM in total.
3. Keep the boot volume plus any other block volumes within the tenancy's
   Always Free storage allowance. A 100 GB boot volume leaves room for backups
   and other volumes, but monitor disk use.
4. Assign a public IPv4 address only after checking its current price in the
   OCI cost estimator. If an IPv4 address is not free, it can make the monthly
   bill nonzero even while the VM is within the Always Free compute quota.
5. Add the contents of `deploy/oracle/cloud-init.yaml` as the instance's
   cloud-init/user-data script. It installs Docker Compose, applies OS package
   updates, enables automatic security updates, configures Docker log rotation,
   and creates `/opt/lantern`. It does not clone the repository, create
   credentials, or start services.
6. Configure the VCN security list or network security group to allow inbound
   TCP 22 only from your current public IP (`/32`), and TCP 80 and 443 from
   the internet. Do not open PostgreSQL, Redis, Grafana, Prometheus, or
   application service ports to the internet.

After cloud-init completes, connect using the SSH key selected at instance
creation, then log out and reconnect so the `ubuntu` account receives its new
Docker group membership:

```bash
ssh ubuntu@YOUR_VM_PUBLIC_IP
docker compose version
sudo systemctl status docker --no-pager
```

The Docker group grants root-equivalent access on the VM. Keep SSH keys private
and restrict SSH ingress to your own address. Before enabling UFW, add the SSH
rule for your current public IP so you do not lock yourself out:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from YOUR_PUBLIC_IP/32 to any port 22 proto tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status verbose
```

## 2. Set up the domain before starting Caddy

The production Caddy configuration needs two hostnames: one for the API and
one for the dashboard. Register a domain or choose a DNS provider, then create
the required A records pointing to the VM's public IPv4 address. Only add AAAA
records if IPv6 is actually configured and reachable. Caddy can then obtain
and renew public TLS certificates when ports 80 and 443 are reachable; see
[Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https).

Do not use the placeholder `.example.com` values in `.env.production.example`
for a public deployment. Do not start the production Compose stack until DNS
resolves to the VM and the actual domain values have been configured.

## 3. Prepare Lantern without putting secrets in Git

After selecting a reviewed Lantern commit to deploy:

```bash
sudo -iu ubuntu
git clone https://github.com/Priyadharsan-85/Lantern.git /opt/lantern
cd /opt/lantern
git checkout YOUR_REVIEWED_COMMIT
cp .env.production.example .env.production
chmod 600 .env.production
nano .env.production
```

Set the real API/dashboard domains, email addresses, SMTP settings, and strong
unique secrets on the VM. Never paste secrets into chat, cloud-init user data,
Git, shell command arguments, or screenshots. Generate random values on the
VM, for example:

```bash
openssl rand -hex 32
```

Use a separate value for each of `PGPASSWORD`, `COLLECTOR_API_KEY`,
`DASHBOARD_AUTH_PASSWORD`, `SESSION_SECRET`, `CUSTOMER_IDENTITY_SECRET`, and
`GRAFANA_ADMIN_PASSWORD`. Leave `PAYMENT_PROVIDER=disabled` and
`PAYMENT_FAILURE_RATE=0`.

Validate the completed environment before deployment:

```bash
cd /opt/lantern
bash ./scripts/validate-prod-env.sh .env.production
docker compose --env-file .env.production -f docker-compose.prod.yml config --quiet
```

The production stack will not be ready for internet use until a real SMTP
provider and off-site backup destination are configured and tested. Follow the
SMTP and backup sections in [PRODUCTION.md](PRODUCTION.md). Do not treat a
successful VM setup or container start as proof that alerts are delivered or
backups can be restored.

Before deploying real data, rehearse the PostgreSQL restore procedure and
confirm off-site backup uploads succeed. Oracle Always Free instances can be
reclaimed, so keep encrypted backups outside the VM and verify them regularly.
