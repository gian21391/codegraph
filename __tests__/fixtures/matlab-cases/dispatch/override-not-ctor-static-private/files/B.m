classdef B < A
    methods
        function obj = B()
            obj@A();
        end
        function hidden(obj)
        end
        function tucked(obj)
        end
    end
    methods (Static)
        function s = make()
            s = 2;
        end
    end
end
