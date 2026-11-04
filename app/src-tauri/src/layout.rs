use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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
        /// Each tab's Attached views (ADR 0013), keyed by the tab that
        /// owns them. Carried here only so a save from Rust keeps them:
        /// every view in a group is a file, board or card tab, never a
        /// session, so nothing in this crate walks them. Absent in state
        /// written before groups, and omitted again when empty, so old
        /// state stays byte-identical.
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        attached: BTreeMap<String, AttachedGroup>,
    },
    Split {
        direction: Direction,
        children: Vec<LayoutNode>,
        sizes: Vec<f64>,
    },
}

/// One tab's Attached views: the side pane's own tab strip, the view in
/// front of it, and the side pane's share of the pane's width.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AttachedGroup {
    pub tabs: Vec<String>,
    #[serde(rename = "activeTabIndex")]
    pub active_tab_index: usize,
    pub size: f64,
}

impl LayoutNode {
    /// Every session id referenced anywhere in the tree, in tree order.
    /// The page tree's own tabs only: an Attached view is never a session,
    /// and walking one here would hand a view's id to the daemon (to attach,
    /// or to replace with a fresh shell) the moment its tab-map entry went
    /// missing.
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
            attached: BTreeMap::new(),
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
                attached: BTreeMap::new(),
            }
        );
    }

    #[test]
    fn pinned_round_trips_and_is_omitted_when_empty() {
        let pinned = LayoutNode::Leaf {
            tabs: vec!["s1".to_string(), "s2".to_string()],
            active_tab_index: 0,
            pinned: vec!["s1".to_string()],
            attached: BTreeMap::new(),
        };
        let json = serde_json::to_value(&pinned).unwrap();
        assert_eq!(json["pinned"], serde_json::json!(["s1"]));
        assert_eq!(serde_json::from_value::<LayoutNode>(json).unwrap(), pinned);

        let plain = serde_json::to_value(&leaf(&["s1"])).unwrap();
        assert!(plain.get("pinned").is_none(), "empty pinned must not be serialized");
    }

    /// A group the frontend saved survives a Rust read and write, in the
    /// exact shape the frontend wrote it, and a leaf with none says nothing.
    #[test]
    fn attached_views_round_trip_and_are_omitted_when_empty() {
        let json = serde_json::json!({
            "type": "leaf",
            "tabs": ["a", "b"],
            "activeTabIndex": 1,
            "attached": { "a": { "tabs": ["diff", "plan"], "activeTabIndex": 1, "size": 0.35 } }
        });
        let tree: LayoutNode = serde_json::from_value(json.clone()).unwrap();
        match &tree {
            LayoutNode::Leaf { attached, .. } => {
                assert_eq!(
                    attached.get("a"),
                    Some(&AttachedGroup {
                        tabs: vec!["diff".to_string(), "plan".to_string()],
                        active_tab_index: 1,
                        size: 0.35,
                    })
                );
            }
            LayoutNode::Split { .. } => panic!("expected a leaf"),
        }
        assert_eq!(serde_json::to_value(&tree).unwrap(), json);
        assert_eq!(tree.all_session_ids(), vec!["a".to_string(), "b".to_string()]);

        let plain = serde_json::to_value(&leaf(&["s1"])).unwrap();
        assert!(plain.get("attached").is_none(), "no groups must not be serialized");
    }
}
