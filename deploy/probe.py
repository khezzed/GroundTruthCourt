# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from genlayer import *

class Probe(gl.Contract):
    val: str

    def __init__(self):
        super().__init__()
        self.val = "init"

    @gl.public.write
    def set_val(self, new_val: str) -> str:
        self.val = new_val
        return new_val

    @gl.public.view
    def get_val(self) -> str:
        return self.val
