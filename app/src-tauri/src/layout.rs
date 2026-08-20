use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Row,
    Column,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum LayoutNode {
    Leaf {
        tabs: Vec<String>,
        #[serde(rename = "activeTabIndex")]
        active_tab_index: usize,
        /// Pinned tab ids (a subset of `tabs`). Absent in state written
        /// before pinning existed, hence the default; omitted again when
        /// empty so old and new state stay byte-identical until used.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        pinned: Vec<String>,
    },
    Split {
        direction: Direction,
        children: Vec<LayoutNode>,
        sizes: Vec<f64>,
    },
}

impl LayoutNode {
    /// Every session id referenced anywhere in the tree, in tree order.
    pub fn all_session_ids(&self) -> Vec<String> {
        match self {
            LayoutNode::Leaf { tabs, .. } => tabs.clone(),
            LayoutNode::Split { children, .. } => {
                children.iter().flat_map(|c| c.all_session_ids()).collect()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(tabs: &[&str]) -> LayoutNode {
        LayoutNode::Leaf {
            tabs: tabs.iter().map(|s| s.to_string()).collect(),
            active_tab_index: 0,
            pinned: Vec::new(),
        }
    }

    #[test]
    fn all_session_ids_on_a_single_leaf() {
        let tree = leaf(&["a", "b"]);
        assert_eq!(tree.all_session_ids(), vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn all_session_ids_across_a_split() {
        let tree = LayoutNode::Split {
            direction: Direction::Row,
            children: vec![leaf(&["a"]), leaf(&["b", "c"])],
            sizes: vec![0.5, 0.5],
        };
        assert_eq!(
            tree.all_session_ids(),
            vec!["a".to_string(), "b".to_string(), "c".to_string()]
        );
    }

    #[test]
    fn serializes_to_the_shape_the_frontend_expects() {
        let tree = leaf(&["s1"]);
        let json = serde_json::to_value(&tree).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "type": "leaf", "tabs": ["s1"], "activeTabIndex": 0 })
        );
    }

    #[test]
    fn split_serializes_to_the_shape_the_frontend_expects() {
        let tree = LayoutNode::Split {
            direction: Direction::Column,
            children: vec![leaf(&["s1"]), leaf(&["s2"])],
            sizes: vec![0.6, 0.4],
        };
        let json = serde_json::to_value(&tree).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "type": "split",
                "direction": "column",
                "children": [
                    { "type": "leaf", "tabs": ["s1"], "activeTabIndex": 0 },
                    { "type": "leaf", "tabs": ["s2"], "activeTabIndex": 0 }
                ],
                "sizes": [0.6, 0.4]
            })
        );
    }

    #[test]
    fn leaf_without_pinned_deserializes_with_no_pinned_tabs() {
        let json = serde_json::json!({ "type": "leaf", "tabs": ["s1", "s2"], "activeTabIndex": 1 });
        let tree: LayoutNode = serde_json::from_value(json).unwrap();
        assert_eq!(
            tree,
            LayoutNode::Leaf {
                tabs: vec!["s1".to_string(), "s2".to_string()],
                active_tab_index: 1,
                pinned: Vec::new(),
            }
        );
    }

    #[test]
    fn pinned_round_trips_and_is_omitted_when_empty() {
        let pinned = LayoutNode::Leaf {
            tabs: vec!["s1".to_string(), "s2".to_string()],
            active_tab_index: 0,
            pinned: vec!["s1".to_string()],
        };
        let json = serde_json::to_value(&pinned).unwrap();
        assert_eq!(json["pinned"], serde_json::json!(["s1"]));
        assert_eq!(serde_json::from_value::<LayoutNode>(json).unwrap(), pinned);

        let plain = serde_json::to_value(&leaf(&["s1"])).unwrap();
        assert!(plain.get("pinned").is_none(), "empty pinned must not be serialized");
    }
}
