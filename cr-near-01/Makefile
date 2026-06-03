committee-build:
	$(MAKE) -C signing_committee build

committee-test:
	$(MAKE) -C signing_committee test

committee-e2e:
	$(MAKE) -C signing_committee e2e

contracts-install:
	cd backend_contracts && npm install

contracts-test:
	cd backend_contracts && npm test

contracts-test-kurtosis:
	cd backend_contracts && npm run test:kurtosis

contracts-e2e-real-committee-kurtosis:
	cd backend_contracts && npm run test:real-committee:kurtosis
