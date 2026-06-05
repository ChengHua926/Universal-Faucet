use drip_cli::voucher::{
    compare_decimal_strings, load_voucher, save_latest_voucher, Voucher, VoucherWrite,
};

#[test]
fn compares_decimal_strings_without_integer_width_limit() {
    assert_eq!(compare_decimal_strings("9", "10"), std::cmp::Ordering::Less);
    assert_eq!(
        compare_decimal_strings("000123", "123"),
        std::cmp::Ordering::Equal
    );
    assert_eq!(
        compare_decimal_strings(
            "1000000000000000000000000000000",
            "999999999999999999999999999999"
        ),
        std::cmp::Ordering::Greater
    );
}

#[test]
fn stores_only_highest_cumulative_voucher() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let voucher_path = temp_dir.path().join("voucher.json");
    let low = Voucher {
        user: "0x1111111111111111111111111111111111111111".to_string(),
        cumulative_amount: "100".to_string(),
        signed_at: 1_780_000_000,
        signature: "0xaaa".to_string(),
    };
    let high = Voucher {
        cumulative_amount: "120".to_string(),
        signed_at: 1_780_000_010,
        signature: "0xbbb".to_string(),
        ..low.clone()
    };

    assert_eq!(
        save_latest_voucher(&voucher_path, &high).expect("save high"),
        VoucherWrite::Stored
    );
    assert_eq!(
        save_latest_voucher(&voucher_path, &low).expect("ignore low"),
        VoucherWrite::IgnoredOlder
    );

    let loaded = load_voucher(&voucher_path).expect("load voucher");
    assert_eq!(loaded, high);
}
