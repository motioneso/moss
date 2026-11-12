//! The nomic model itself. It turns one text into 768 numbers the way the old app did (the
//! transformers.js pipeline): tokenise, run, average over tokens, scale to length one.
use anyhow::{anyhow, Result};
use ort::{session::Session, value::Tensor};
use std::{path::Path, sync::OnceLock};
use tokenizers::Tokenizer;

/// Longest token sequence the model sees. Attention cost grows with the square of the length
/// (issue 1359 in the old app: 8192 tokens took 6.8 GB). The old app cut at the same place.
pub const MAX_TOKENS: usize = 512;
pub const DIMENSIONS: usize = 768;

pub struct Engine {
    tokenizer: Tokenizer,
    session: Session,
}

fn plain<T: std::fmt::Display>(e: T) -> anyhow::Error {
    anyhow!("{e}")
}

/// ONNX Runtime allows one environment per process, and the engine can be loaded again after it
/// has been unloaded for being idle.
fn environment() -> Result<&'static ort::environment::Environment> {
    static ENVIRONMENT: OnceLock<Result<ort::environment::Environment, String>> = OnceLock::new();
    ENVIRONMENT
        .get_or_init(|| {
            // Telemetry is on by default in ONNX Runtime. No text or usage leaves the device.
            ort::init()
                .with_name("moss")
                .with_telemetry(false)
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(|e| anyhow!("{e}"))
}

impl Engine {
    pub fn load(folder: &Path) -> Result<Self> {
        let tokenizer = Tokenizer::from_file(folder.join("tokenizer.json")).map_err(plain)?;
        let threads = std::thread::available_parallelism().map_or(2, |n| n.get().clamp(1, 4));
        let session = Session::builder(environment()?)
            .map_err(plain)?
            .with_intra_threads(threads)
            .map_err(plain)?
            .commit_from_file(folder.join("model.onnx"))
            .map_err(plain)?;
        Ok(Self { tokenizer, session })
    }

    /// Token ids for a text, cut at 512 like the old app. Its tokenizer drops the closing
    /// separator when it cuts, and the stored vectors were made that way, so this does too.
    pub fn token_ids(&self, text: &str) -> Result<Vec<i64>> {
        let encoding = self.tokenizer.encode(text, true).map_err(plain)?;
        Ok(encoding
            .get_ids()
            .iter()
            .take(MAX_TOKENS)
            .map(|&id| i64::from(id))
            .collect())
    }

    pub fn embed(&mut self, text: &str) -> Result<Vec<f32>> {
        let ids = self.token_ids(text)?;
        let n = ids.len();
        anyhow::ensure!(n > 0, "Nothing to embed");
        let outputs = self
            .session
            .run(ort::inputs![
                "input_ids" => Tensor::from_array(([1usize, n], ids)).map_err(plain)?,
                "attention_mask" => Tensor::from_array(([1usize, n], vec![1i64; n])).map_err(plain)?,
                "token_type_ids" => Tensor::from_array(([1usize, n], vec![0i64; n])).map_err(plain)?,
            ])
            .map_err(plain)?;
        let (shape, data) = outputs[0].try_extract_tensor::<f32>().map_err(plain)?;
        anyhow::ensure!(
            shape.len() == 3 && shape[2] as usize == DIMENSIONS && data.len() == n * DIMENSIONS,
            "The model returned an unexpected shape"
        );
        let mut mean = vec![0f64; DIMENSIONS];
        for token in data.chunks_exact(DIMENSIONS) {
            for (sum, value) in mean.iter_mut().zip(token) {
                *sum += f64::from(*value);
            }
        }
        let norm = mean.iter().map(|x| x * x).sum::<f64>().sqrt();
        anyhow::ensure!(
            norm.is_finite() && norm > 0.0,
            "The model returned no usable vector"
        );
        Ok(mean.iter().map(|x| (x / norm) as f32).collect())
    }
}
