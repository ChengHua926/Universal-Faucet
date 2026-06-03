# Use the glibc "slim" image (not alpine): web3's native dependencies ship
# prebuilt manylinux wheels for glibc, so installs are fast and don't compile.
FROM python:3.11-slim

WORKDIR /app

# Install Python deps first so this layer is cached unless requirements change.
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

# Copy the oracle code. Model B service modules + shared crypto. oracle.py is
# the legacy Model A push loop, kept for reference but not the entrypoint.
COPY oracle_service.py server.py source_rpc.py report_builder.py kms_key.py \
     contract_client.py report_cache.py rate_limit.py signer_key.py \
     header_report.py evm_header.py rofl_appd.py oracle.py /app/

# Run the Model B oracle: register the header signer once, then serve signed
# reports over HTTP. ORACLE_MODE=rofl (compose.yaml) signs/registers via appd.
ENTRYPOINT ["python", "oracle_service.py"]
