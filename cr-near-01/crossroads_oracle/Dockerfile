# Use the glibc "slim" image (not alpine): web3's native dependencies ship
# prebuilt manylinux wheels for glibc, so installs are fast and don't compile.
FROM python:3.11-slim

WORKDIR /app

# Install Python deps first so this layer is cached unless requirements change.
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

# Copy the oracle code: the Model B service modules + shared crypto. The TEE
# (ROFL KMS) is the only signer; multi_chain.py + url_guard.py add the
# per-request, contract-configured multi-chain path.
COPY oracle_service.py server.py source_rpc.py report_builder.py kms_key.py \
     contract_client.py report_cache.py rate_limit.py multi_chain.py \
     url_guard.py header_report.py evm_header.py rofl_appd.py /app/

# Run the Model B oracle: register the header signer once, then serve signed
# reports over HTTP. ORACLE_MODE=rofl (compose.yaml) signs/registers via appd.
ENTRYPOINT ["python", "oracle_service.py"]
