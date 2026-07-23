#!/bin/bash
docker save bottalk-app:latest bottalk-feishu:latest bottalk-wecom:latest -o /tmp/bottalk-images3.tar
for node in 10.44.0.161 10.44.0.31 10.44.0.19; do
  ssh root@$node "ctr -a /run/k3s/containerd/containerd.sock -n k8s.io images import -" < /tmp/bottalk-images3.tar
  echo "Imported to $node"
done
kubectl delete pods --all -n bottalk
