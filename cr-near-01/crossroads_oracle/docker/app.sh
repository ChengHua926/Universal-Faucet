#!/bin/sh

mkdir -p /www

write_status() {
	jq -n \
		--arg contract "${CONTRACT_ADDRESS}" \
		--arg ticker "${TICKER}" \
		--arg price "${1:-}" \
		--arg submit "${2:-starting}" \
		--arg updated "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
		'{
			ok: true,
			contract: $contract,
			ticker: $ticker,
			last_price: $price,
			last_submit: $submit,
			updated_at: $updated
		}' >/www/status
}

write_status "" "starting"
httpd -f -p 0.0.0.0:5678 -h /www &

echo "Updating metadata"
curl -s \
	--json '{"api": "binance"}' \
	--unix-socket /run/rofl-appd.sock \
	http://localhost/rofl/v1/metadata >/dev/null

echo "Querying ROFL app information"
# Query rofl.App to get app configuration
# CBOR-encoded AppQuery struct with app_id decoded:
# rofl1qphzf28av4g7xhnyddscxfxugsn292wrcqmh7dlv -> 006e24a8fd6551e35e646b618324dc4426a2a9c3c0
# CBOR format: a1 (map) + 626964 (key "id") + 55 (byte string, 21 bytes) + app_id
app_id="a162696455006e24a8fd6551e35e646b618324dc4426a2a9c3c0"
curl -s \
	--json '{"method": "rofl.App", "args": "'${app_id}'"}' \
	--unix-socket /run/rofl-appd.sock \
	http://localhost/rofl/v1/query

while true; do
	# Fetch a recent price from Binance.
	price=$(curl -s "https://www.binance.com/api/v3/ticker/price?symbol=${TICKER}" | jq '(.price | tonumber) * 1000000 | trunc')
	if [ -z "$price" ]; then
		write_status "" "price fetch failed"
		sleep 15
		continue
	fi

	# Format calldata to call submitObservation(uint128) method with the price.
	price_u128=$(printf '%064x' ${price})
	method="dae1ee1f" # Keccak4("submitObservation(uint128)")
	data="${method}${price_u128}"

	# Submit it to the Sapphire contract.
	echo "Submitting observation ${price} to ${CONTRACT_ADDRESS}"
	submit_response=$(curl -sS \
		--json '{"tx": {"kind": "eth", "data": {"gas_limit": 200000, "to": "'${CONTRACT_ADDRESS}'", "value": 0, "data": "'${data}'"}}}' \
		--unix-socket /run/rofl-appd.sock \
		http://localhost/rofl/v1/tx/sign-submit)
	echo "${submit_response}"
	write_status "${price}" "${submit_response}"

	# Sleep for a while.
	sleep 60
done
