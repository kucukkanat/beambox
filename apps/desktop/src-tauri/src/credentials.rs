//! Harness credentials, stored once in the OS keychain and passed to a harness only as its environment.
use crate::backend::Result;

/// The credentials Beambox knows about.
pub const PROVIDERS: &[&str] = &["anthropic", "openai"];
const SERVICE: &str = "app.beambox.desktop";

/// Where credentials live. The real one is the OS keychain; tests use `fake::FakeSecrets`.
pub trait Secrets: Send + Sync {
    fn get(&self, name: &str) -> Result<Option<String>>;
    fn set(&self, name: &str, value: &str) -> Result<()>;
    fn remove(&self, name: &str) -> Result<()>;
}

/// Names of the stored credentials, never their values.
pub fn stored(secrets: &dyn Secrets) -> Result<Vec<String>> {
    let mut names = Vec::new();
    for name in PROVIDERS {
        if secrets.get(name)?.is_some() {
            names.push(name.to_string());
        }
    }
    Ok(names)
}

pub fn check_provider(name: &str) -> Result<()> {
    if PROVIDERS.contains(&name) { Ok(()) } else { Err(format!("unknown credential {name}; use one of {}", PROVIDERS.join(", "))) }
}

/// macOS Keychain, Windows Credential Manager or the Secret Service, through the `keyring` crate.
pub struct Keychain;

impl Secrets for Keychain {
    fn get(&self, name: &str) -> Result<Option<String>> {
        match keyring::Entry::new(SERVICE, name).and_then(|e| e.get_password()) {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("can't read the {name} credential from the keychain: {e}")),
        }
    }
    fn set(&self, name: &str, value: &str) -> Result<()> {
        check_provider(name)?;
        keyring::Entry::new(SERVICE, name).and_then(|e| e.set_password(value)).map_err(|e| e.to_string())
    }
    fn remove(&self, name: &str) -> Result<()> {
        match keyring::Entry::new(SERVICE, name).and_then(|e| e.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(test)]
pub mod fake {
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct FakeSecrets(pub Mutex<BTreeMap<String, String>>);

    impl FakeSecrets {
        pub fn with(name: &str, value: &str) -> Self {
            let secrets = Self::default();
            secrets.0.lock().unwrap().insert(name.into(), value.into());
            secrets
        }
    }

    impl Secrets for FakeSecrets {
        fn get(&self, name: &str) -> Result<Option<String>> {
            Ok(self.0.lock().unwrap().get(name).cloned())
        }
        fn set(&self, name: &str, value: &str) -> Result<()> {
            check_provider(name)?;
            self.0.lock().unwrap().insert(name.into(), value.into());
            Ok(())
        }
        fn remove(&self, name: &str) -> Result<()> {
            self.0.lock().unwrap().remove(name);
            Ok(())
        }
    }
}
